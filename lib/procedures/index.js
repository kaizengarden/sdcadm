/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * The collection of "procedure" functions that know how to perform part of
 * an update plan (i.e. for `sdcadm update`).
 */

var p = console.log;
var assert = require('assert-plus');
var child_process = require('child_process'),
    execFile = child_process.execFile,
    spawn = child_process.spawn;
var fs = require('fs');
var once = require('once');
var os = require('os');
var path = require('path');
var sprintf = require('extsprintf').sprintf;
var util = require('util'),
    format = util.format;
var vasync = require('vasync');
var verror = require('verror');

var common = require('../common');
var errors = require('../errors'),
    InternalError = errors.InternalError;
var svcadm = require('../svcadm');
var vmadm = require('../vmadm');



//---- internal support stuff

function NoOp() {}
NoOp.prototype.summarize = function noOpSummarize() {
    return 'no-op';
};
NoOp.prototype.execute = function noOpExecute(options, cb) {
    cb();
};



//---- procedures from the modules where we've defined them:
var DownloadImages = require('./download-images').DownloadImages;
var UpdateStatelessServicesV1 =
    require('./update-stateless-services-v1').UpdateStatelessServicesV1;
var UpdateSingleHeadnodeImgapi =
    require('./update-single-headnode-imgapi').UpdateSingleHeadnodeImgapi;
var UpdateUFDSServiceV1 =
    require('./update-ufds-service-v1').UpdateUFDSServiceV1;
var UpdateMorayV2 = require('./update-moray-v2').UpdateMorayV2;
var UpdateSingleHNSapiV1 =
    require('./update-single-hn-sapi-v1').UpdateSingleHNSapiV1;
var UpdateManateeV2 = require('./update-manatee-v2').UpdateManateeV2;
var UpdateBinderV1 = require('./update-binder-v1').UpdateBinderV1;
var UpdateMahiV1 = require('./update-mahi-v1').UpdateMahiV1;

/**
 * This is the function that determines *how* we are going to update.
 *
 * Returns an array of procedure objects that will (in-order) handle the
 * full given update plan. This will error out if the plan cannot be
 * handled (i.e. if this tool doesn't know how to update something yet).
 *
 * @param opts {Object}  Required.
 *      - plan {UpdatePlan} Required.
 *      - log {Bunyan Logger} Required.
 *      - serverFromUuidOrHostname {Object} Required.
 * @param cb {Function} Callback of the form `function (err, procs)`.
 */
function coordinatePlan(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.optionalFunc(opts.progress, 'opts.progress');
    assert.object(opts.serverFromUuidOrHostname,
        'opts.serverFromUuidOrHostname');
    assert.func(cb, 'cb');
    var log = opts.log;
    var progress = opts.progress || function () {};
    var sdcadm = opts.sdcadm;
    var instsFromSvcName = {};
    var insts = opts.plan.curr;
    for (var i = 0; i < insts.length; i++) {
        var inst = insts[i];
        var svcName = inst.service;
        if (!instsFromSvcName[svcName]) {
            instsFromSvcName[svcName] = [];
        }
        instsFromSvcName[svcName].push(inst);
    }

    var changes = opts.plan.changes.slice();
    var procs = [];
    vasync.pipeline({funcs: [
        /**
         * Add the procedure for downloading images (from updates.joyent.com),
         * if necessary.
         */
        function coordImages(_, next) {
            var imageFromUuid = {};
            for (var c = 0; c < changes.length; c++) {
                var img = changes[c].image;
                if (img) {
                    imageFromUuid[img.uuid] = img;
                }
            }
            var images = Object.keys(imageFromUuid).map(
                function (uuid) { return imageFromUuid[uuid]; });
            var imagesToRetrieve = [];
            vasync.forEachParallel({
                inputs: images,
                func: function imageExists(image, nextImage) {
                    sdcadm.imgapi.getImage(image.uuid, function (err, local) {
                        if (err && err.body.code === 'ResourceNotFound') {
                            imagesToRetrieve.push(image);
                            nextImage();
                        } else if (err) {
                            nextImage(new errors.SDCClientError(err, 'imgapi'));
                        } else {
                            nextImage();
                        }
                    });
                }
            }, function (err) {
                if (err) {
                    return next(err);
                }
                if (imagesToRetrieve.length > 0) {
                    procs.push(new DownloadImages({images: imagesToRetrieve}));
                }
                next();
            });
        },

        /**
         * Update services that are (a) stateless, (b) have a single instance
         * **on the headnode**, (c) with no current special handling (like
         * migrations).
         *
         * Here (b) implies this is the early SDC world where we don't have
         * HA multiple instances of services.
         */
        function updateSimpleServices(_, next) {
            var simpleServices = ['adminui', 'amon', 'amonredis', 'assets',
                'ca', 'cloudapi', 'cnapi', 'dhcpd', 'fwapi', 'napi', 'papi',
                'rabbitmq', 'redis', 'sdc', 'vmapi', 'workflow', 'manta'];
            var handle = [];
            var remaining = [];
            var currHostname = os.hostname();
            changes.forEach(function (change) {
                var svcInsts = instsFromSvcName[change.service.name] || [];
                if (change.type === 'update-service' &&
                    ~simpleServices.indexOf(change.service.name))
                {
                    if (svcInsts.length === 0) {
                        log.debug({
                                numInsts: 0,
                                svc: change.service.name
                            }, 'UpdateStatelessServicesV1 update service ' +
                            'with no instance');

                        progress('Note: There are no "%s" instances. ' +
                            'Only the service configuration will be ' +
                            'updated.', change.service.name);
                        // Push an instance-less service update
                        handle.push(change);
                    } else if (svcInsts.length !== 1) {
                        log.debug({
                                numInsts: svcInsts.length,
                                svc: change.service.name
                            }, 'UpdateStatelessServicesV1 skip change: ' +
                            'not 1 inst');
                    } else if (svcInsts[0].hostname !== currHostname) {
                        log.debug({
                                svc: change.service.name,
                                cn: svcInsts[0].server
                            }, 'UpdateStatelessServicesV1 skip change: ' +
                            'inst not on headnode');
                    } else {
                        change.inst = svcInsts[0];
                        handle.push(change);
                    }
                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle},
                    'UpdateStatelessServicesV1 will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateStatelessServicesV1({
                    changes: handle
                }));
            }
            next();
        },

        function updateSingleHeadnodeImgapi(_, next) {
            var handle = [];
            var remaining = [];
            var currHostname = os.hostname();
            changes.forEach(function (change) {
                var svcInsts = instsFromSvcName[change.service.name] || [];
                if (change.type === 'update-service' &&
                    change.service.name === 'imgapi')
                {
                    if (svcInsts.length !== 1) {
                        log.debug({
                                numInsts: svcInsts.length,
                                svc: change.service.name
                            }, 'UpdateSingleHeadnodeImgapi skip change: ' +
                            'not 1 inst');
                    } else if (svcInsts[0].hostname !== currHostname) {
                        log.debug({
                                svc: change.service.name,
                                cn: svcInsts[0].server
                            }, 'UpdateSingleHeadnodeImgapi skip change: ' +
                            'inst not on headnode');
                    } else {
                        change.inst = svcInsts[0];
                        handle.push(change);
                    }
                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle},
                    'UpdateSingleHeadnodeImgapi will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateSingleHeadnodeImgapi({
                    changes: handle
                }));
            }
            next();
        },

        function updateSingleHeadnodeUFDS(_, next) {
            var handle = [];
            var remaining = [];
            var currHostname = os.hostname();
            changes.forEach(function (change) {
                var svcInsts = instsFromSvcName[change.service.name] || [];
                if (change.type === 'update-service' &&
                    change.service.name === 'ufds')
                {
                    if (svcInsts.length !== 1) {
                        log.debug({
                                numInsts: svcInsts.length,
                                svc: change.service.name
                            }, 'UpdateUFDSServiceV1 skip change: ' +
                            'not 1 inst');
                    } else if (svcInsts[0].hostname !== currHostname) {
                        log.debug({
                                svc: change.service.name,
                                cn: svcInsts[0].server
                            }, 'UpdateUFDSServiceV1 skip change: ' +
                            'inst not on headnode');
                    } else {
                        change.inst = svcInsts[0];
                        handle.push(change);
                    }
                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle},
                    'UpdateUFDSServiceV1 will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateUFDSServiceV1({
                    changes: handle
                }));
            }
            next();
        },

        // Moving to full HA update. It shouldn't matter where each VM is
        // running:
        function updateMorays(_, next) {
            var handle = [];
            var remaining = [];
            changes.forEach(function (change) {
                if (change.type === 'update-service' &&
                    change.service.name === 'moray')
                {
                    var svcInsts = instsFromSvcName[change.service.name] || [];
                    if (svcInsts.length && svcInsts.length > 1) {
                        change.insts = svcInsts;
                    } else {
                        change.inst = svcInsts[0];
                    }
                    handle.push(change);
                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle},
                    'updateMorays will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateMorayV2({
                    changes: handle
                }));
            }
            next();
        },

        function updateSingleHeadnodeSapi(_, next) {
            var handle = [];
            var remaining = [];
            var currHostname = os.hostname();
            changes.forEach(function (change) {
                var svcInsts = instsFromSvcName[change.service.name] || [];
                if (change.type === 'update-service' &&
                    change.service.name === 'sapi')
                {
                    if (svcInsts.length !== 1) {
                        log.debug({
                                numInsts: svcInsts.length,
                                svc: change.service.name
                            }, 'UpdateSingleHNSapiV1 skip change: ' +
                            'not 1 inst');
                    } else if (svcInsts[0].hostname !== currHostname) {
                        log.debug({
                                svc: change.service.name,
                                cn: svcInsts[0].server
                            }, 'UpdateSingleHNSapiV1 skip change: ' +
                            'inst not on headnode');
                    } else {
                        change.inst = svcInsts[0];
                        handle.push(change);
                    }
                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle},
                    'UpdateSingleHNSapiV1 will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateSingleHNSapiV1({
                    changes: handle
                }));
            }
            next();
        },

        /**
         * Manatee service upgrade plan:
         *
         * 1) disable all peers except for the primary
         * 2) put the primary in one node write mode
         * 3) update other peers
         * 4) disable the primary
         * 5) wait for the sync to be promoted
         * 6) update the primary
         *
         * Note we assume there's at least one manatee on the server from where
         * we are performing the upgrade.
         */
        function updateManatees(_, next) {
            var handle = [];
            var remaining = [];

            changes.forEach(function (change) {
                if (change.type === 'update-service' &&
                    change.service.name === 'manatee')
                {
                    // Note this is completely different than "single" and
                    // in "HN" functions above. For manatee, we'll try to
                    // update all of them, despite of the server they're
                    // into:
                    var svcInsts = instsFromSvcName[change.service.name] || [];
                    if (svcInsts.length && svcInsts.length > 1) {
                        change.insts = svcInsts;
                    } else {
                        change.inst = svcInsts[0];
                    }
                    handle.push(change);
                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle},
                    'updateManatees will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateManateeV2({
                    changes: handle
                }));
            }
            next();
        },

        function updateBinder(_, next) {
            var handle = [];
            var remaining = [];
            var currHostname = os.hostname();
            changes.forEach(function (change) {
                var svcInsts = instsFromSvcName[change.service.name] || [];
                if (change.type === 'update-service' &&
                    change.service.name === 'binder')
                {
                    if (svcInsts.length !== 1) {
                        log.debug({
                                numInsts: svcInsts.length,
                                svc: change.service.name
                            }, 'UpdateBinderV1 skip change: ' +
                            'not 1 inst');
                    } else if (svcInsts[0].hostname !== currHostname) {
                        log.debug({
                                svc: change.service.name,
                                cn: svcInsts[0].server
                            }, 'UpdateBinderV1 skip change: ' +
                            'inst not on headnode');
                    } else {
                        change.inst = svcInsts[0];
                        handle.push(change);
                    }
                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle},
                    'UpdateBinderV1 will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateBinderV1({ changes: handle }));
            }
            next();
        },

        function updateMahi(_, next) {
            var handle = [];
            var remaining = [];
            var currHostname = os.hostname();
            changes.forEach(function (change) {
                var svcInsts = instsFromSvcName[change.service.name] || [];
                if (change.type === 'update-service' &&
                    change.service.name === 'mahi')
                {
                    if (svcInsts.length !== 1) {
                        log.debug({
                                numInsts: svcInsts.length,
                                svc: change.service.name
                            }, 'UpdateMahiV1 skip change: ' +
                            'not 1 inst');
                    } else if (svcInsts[0].hostname !== currHostname) {
                        log.debug({
                                svc: change.service.name,
                                cn: svcInsts[0].server
                            }, 'UpdateMahiV1 skip change: ' +
                            'inst not on headnode');
                    } else {
                        change.inst = svcInsts[0];
                        handle.push(change);
                    }
                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle},
                    'UpdateMahiV1 will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateMahiV1({ changes: handle }));
            }
            next();
        }

        // TODO: last is to purge unused core images (housekeeping)
        //      Plan: if can, add a marker (tag?) to images imported by
        //      'sdcadm' so know that we can feel more confident removing
        //      these ones. Can't think of current use cases for not
        //      purging images. Add a boolean config to not do this at all.
        //      Add a separate 'sdcadm purge-images/cleanup-images' or
        //      something.
        // TODO: Also purge older unused images *on the CN zpools*.
    ]}, function done(err) {
        if (err) {
            cb(err);
        } else if (changes.length) {
            var summary = changes
                .map(function (c) {
                    var sum = {};
                    if (c.type) { sum.type = c.type; }
                    if (c.service) { sum.service = c.service.name; }
                    if (c.image) { sum.image = c.image.uuid; }
                    return sum;
                })
                .map(function (c) { return JSON.stringify(c); })
                .join('\n    ');
            cb(new errors.UpdateError(
                'do not support the following changes:\n    ' + summary));
        } else {
            if (opts.plan.justImages) {
                procs = procs.filter(function (proc) {
                    return proc.constructor.name === 'DownloadImages';
                });
            }
            cb(null, procs);
        }
    });
}


//---- exports

module.exports = {
    coordinatePlan: coordinatePlan
};
// vim: set softtabstop=4 shiftwidth=4:
