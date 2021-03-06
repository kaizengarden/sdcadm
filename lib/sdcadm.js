/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Core SdcAdm class.
 */

var assert = require('assert-plus');
var child_process = require('child_process'),
    spawn = child_process.spawn,
    exec = child_process.exec;
var format = require('util').format;
var fs = require('fs');
var http  = require('http');
var https = require('https');
var p = console.log;
var path = require('path');
var mkdirp = require('mkdirp');
var sdcClients = require('sdc-clients');
var semver = require('semver');
var sprintf = require('extsprintf').sprintf;
var UrClient = require('urclient');
var vasync = require('vasync');
var WfClient = require('wf-client');
var uuid = require('node-uuid');

var common = require('./common');
var errors = require('./errors');
var lock = require('./locker').lock;
var pkg = require('../package.json');
var procedures = require('./procedures');
var History = require('./history').History;

var UA = format('%s/%s (node/%s; openssl/%s)', pkg.name, pkg.version,
        process.versions.node, process.versions.openssl);
var UPDATE_PLAN_FORMAT_VER = 1;

var PING_PATHS = {
    // vms
    amon:     '/ping',
    cloudapi: '/--ping',
    cnapi:    '/ping',
    fwapi:    '/ping',
    imgapi:   '/ping',
    napi:     '/ping',
    papi:     '/ping',
    sapi:     '/ping',
    vmapi:    '/ping',
    workflow: '/ping',
    // agents
    firewaller: '/status'
};

var PING_PORTS = {
    cloudapi: 443,
    firewaller: 2021
};


//---- UpdatePlan class
// A light data object with some conveninence functions.

function UpdatePlan(options) {
    assert.object(options, 'options');
    assert.arrayOfObject(options.curr, 'options.curr');
    assert.arrayOfObject(options.targ, 'options.targ');
    assert.arrayOfObject(options.changes, 'options.changes');
    assert.bool(options.justImages, 'options.justImages');

    this.v = UPDATE_PLAN_FORMAT_VER;
    this.curr = options.curr;
    this.targ = options.targ;
    this.changes = options.changes;
    this.justImages = options.justImages;
}

UpdatePlan.prototype.serialize = function serialize() {
    return JSON.stringify({
        v: this.v,
        targ: this.targ,
        changes: this.changes,
        justImages: this.justImages
    }, null, 4);
};



//---- SdcAdm class

/**
 * Create a SdcAdm.
 *
 * @param options {Object}
 *      - log {Bunyan Logger}
 */
function SdcAdm(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.optionalString(options.profile, 'options.profile');

    if (!options.uuid) {
        options.uuid = uuid();
    }

    var self = this;

    this.log = options.log;
    this.uuid = options.uuid;

    self._lockPath = '/var/run/sdcadm.lock';

    self.userAgent = UA;
    Object.defineProperty(this, 'sapi', {
        get: function () {
            if (self._sapi === undefined) {
                self._sapi = new sdcClients.SAPI({
                    url: self.config.sapi.url,
                    agent: false,
                    userAgent: self.userAgent,
                    log: self.log
                });
            }
            return self._sapi;
        }
    });
    Object.defineProperty(this, 'cnapi', {
        get: function () {
            if (self._cnapi === undefined) {
                self._cnapi = new sdcClients.CNAPI({
                    url: self.config.cnapi.url,
                    agent: false,
                    userAgent: self.userAgent,
                    log: self.log
                });
            }
            return self._cnapi;
        }
    });
    Object.defineProperty(this, 'vmapi', {
        get: function () {
            if (self._vmapi === undefined) {
                self._vmapi = new sdcClients.VMAPI({
                    url: self.config.vmapi.url,
                    agent: false,
                    userAgent: self.userAgent,
                    log: self.log
                });
            }
            return self._vmapi;
        }
    });
    Object.defineProperty(this, 'imgapi', {
        get: function () {
            if (self._imgapi === undefined) {
                self._imgapi = new sdcClients.IMGAPI({
                    url: self.config.imgapi.url,
                    agent: false,
                    userAgent: self.userAgent,
                    version: '~2',
                    log: self.log
                });
            }
            return self._imgapi;
        }
    });
    Object.defineProperty(this, 'updates', {
        get: function () {
            if (self._updates === undefined) {
                self._updates = new sdcClients.IMGAPI({
                    url: self.config.updatesServerUrl,
                    agent: false,
                    userAgent: self.userAgent,
                    log: self.log
                });
            }
            return self._updates;
        }
    });
    Object.defineProperty(this, 'napi', {
        get: function () {
            if (self._napi === undefined) {
                self._napi = new sdcClients.NAPI({
                    url: self.config.napi.url,
                    agent: false,
                    userAgent: self.userAgent,
                    log: self.log
                });
            }
            return self._napi;
        }
    });
    Object.defineProperty(this, 'wfapi', {
        get: function () {
            if (self._wfapi === undefined) {
                self._wfapi = new WfClient({
                    url: self.config.wfapi.url,
                    agent: false,
                    path: './not/used/because/we/do/not/loadWorkflows',
                    // TODO: Get wf-client to take `userAgent`.
                    //userAgent: self.userAgent,
                    log: self.log.child({client: 'wfapi'}, true)
                });
            }
            return self._wfapi;
        }
    });
    // NOTE: A method using self.ufds should take care of
    // calling self._ufds.close(function (err) {});
    Object.defineProperty(this, 'ufds', {
        get: function () {
            if (self._ufds === undefined) {
                self._ufds = new sdcClients.UFDS({
                    url: self.config.ufds.url,
                    bindDN: self.config.ufds.bindDN,
                    bindPassword: self.config.ufds.bindPassword,
                    maxConnections: 1,
                    retry: {
                        initialDelay: 1000
                    },
                    clientTimeout: 120000,
                    tlsOptions: {
                        rejectUnauthorized: false
                    },
                    log: self.log
                });
                self._ufds.once('error', function (err) {
                    throw err;
                });

                self._ufds.once('connect', function () {
                    self._ufds.removeAllListeners('error');
                    self._ufds.on('error', function (err) {
                        self.log.info('UFDS disconnected');
                    });
                    self._ufds.on('connect', function () {
                        self.log.info('UFDS reconnected');
                    });
                    self._ufds.on('timeout', function (msg) {
                        self.log.error(msg);
                        self._ufds.client.socket.destroy();
                    });
                });

            }
            return self._ufds;
        }
    });
    Object.defineProperty(this, 'ur', {
        get: function () {
            if (self._ur === undefined) {
                self._ur = UrClient.create_ur_client({
                    connect_timeout: 5000,  // in ms
                    enable_http: false,
                    amqp_config: self.config.amqp,
                    log: self.log.child({client: 'ur'}, true)
                });
            }
            return self._ur;
        }
    });
}


SdcAdm.prototype.init = function init(cb) {
    var self = this;
    var opts = {
        log: self.log
    };
    common.loadConfig(opts, function (err, config) {
        if (err) {
            return cb(err);
        }
        self.config = config;
        if (self.config.serverUuid) {
            self.userAgent += ' server=' + self.config.serverUuid;
        }
        self.history = new History({
            log: self.log,
            sdcadm: self
        });

        self.history.init(cb);
    });
};


/**
 * Gather a JSON object for each installed SDC service instance.
 *
 * "Services" include: SDC core vms and agents.
 *
 * TODO:
 * - gz tools
 * - sdcadm itself (need to get the manifest file installed for this)
 * - buildstamp field once have more consistent semver versioning
 *
 * All types will have these fields:
 *      type            type of service, e.g. 'vm', 'agent', 'platform'
 *      service         name of service, e.g. 'vmapi, 'provisioner', 'platform'
 *      image           image UUID (Note: Platforms and agents aren't
 *                      currently distributed as separate "images" in
 *                      updates.joyent.com. Until they are `image === null`.)
 *      version         version string, e.g. '1.2.3', '7.0/20140101T12:43:55Z'
 *      server          server uuid
 *      hostname        server hostname
 */
SdcAdm.prototype.getInstances = function getInstances(opts, cb) {
    var self = this;
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    var insts = [];
    var serversFromUuid = {};
    var agentNameFromSvcUuid = {};
    var sapiAgentInstFromName = {};

    vasync.pipeline({funcs: [
        // Get uuids and image uuids for the agents that exist in SAPI
        function getAgentServices(_, next) {
            // XXX this should restrict to the 'sdc' app
            var filters = { type: 'agent' };
            self.sapi.listServices(filters, function (svcErr, svcs) {
                if (svcErr) {
                    return next(new errors.SDCClientError(svcErr, 'sapi'));
                }
                svcs.forEach(function (svc) {
                    agentNameFromSvcUuid[svc.uuid] = svc.name;
                });
                return next();
            });
        },
        function getAgentInstances(_, next) {
            var filters = { type: 'agent' };
            self.sapi.listInstances(filters, function (instErr, instances) {
                if (instErr) {
                    return next(new errors.SDCClientError(instErr, 'sapi'));
                }
                instances.forEach(function (inst) {
                    sapiAgentInstFromName[
                        agentNameFromSvcUuid[inst.service_uuid]] = inst;
                });
                return next();
            });
        },
        function getAgentsAndPlatforms(_, next) {
            var serverOpts = {
                extras: 'sysinfo'
            };
            self.cnapi.listServers(serverOpts, function (serversErr, servers) {
                if (serversErr) {
                    return next(serversErr);
                }
                servers.forEach(function (server) {
                    serversFromUuid[server.uuid] = server;

                    // TODO: re-include platforms via SAPI.
                    //var sdcVersion = server.sysinfo['SDC Version'] || '6.5';
                    //var version = format('%s:%s', sdcVersion,
                    //    server.current_platform);
                    //insts.push({
                    //    type: 'platform',
                    //    service: 'platform',
                    //    version: version,
                    //    image: null,
                    //    sdc_version: sdcVersion,
                    //    platform: server.current_platform,
                    //    server: server.uuid,
                    //    hostname: server.hostname
                    //});

                    var nics = server.sysinfo['Network Interfaces'] || {};
                    var adminIp = Object.keys(nics).map(function (nicName) {
                        return nics[nicName];
                    }).filter(function (nic) {
                        return nic['NIC Names'].indexOf('admin') !== -1;
                    }).map(function (nic) {
                        return nic.ip4addr;
                    })[0];

                    (server.sysinfo['SDC Agents'] || []).forEach(
                            function (agent) {
                        var sapiInst = sapiAgentInstFromName[agent.name];
                        var instUuid = sapiInst && sapiInst.uuid ||
                            // The old deprecated "uuid" for agent insts:
                            (server.uuid + '/' + agent.name);
                        var agentInst = {
                            type: 'agent',
                            service: agent.name,
                            instance: instUuid,
                            version: agent.version,
                            image: agent.image, // TODO will come eventually
                            server: server.uuid,
                            hostname: server.hostname
                        };
                        if (adminIp) {
                            agentInst.ip = adminIp;
                        }
                        insts.push(agentInst);
                    });
                });
                next();
            });
        },
        function getCoreZones(_, next) {
            // 'cloudapi' zones typically don't have `tags.smartdc_core=true`
            // so we can't filter on that. And VMAPI doesn't support filtering
            // on presence of a tag (e.g. `smartdc_role`.)
            var filters = {
                state: 'active',
                owner_uuid: self.config.ufds_admin_uuid
            };
            self.vmapi.listVms(filters, function (vmsErr, vms) {
                if (vmsErr) {
                    return next(vmsErr);
                }
                vms = vms.filter(function (vm) {
                    return vm.tags && vm.tags.smartdc_role;
                });
                // TODO: log vms info here.
                vasync.forEachParallel({
                    inputs: vms,
                    func: function addOneCoreZone(vm, nextVm) {
                        self.imgapi.getImage(vm.image_uuid, function (e, img) {
                            if (e) {
                                return nextVm(e);
                            }

                            var vmDetails = {
                                type: 'vm',
                                alias: vm.alias,
                                version: img.version,
                                instance: vm.uuid,
                                zonename: vm.uuid,
                                service: vm.tags.smartdc_role,
                                image: vm.image_uuid,
                                server: vm.server_uuid,
                                hostname: serversFromUuid[
                                    vm.server_uuid].hostname
                            };

                            var adminIp = vm.nics.filter(function (nic) {
                                return nic.nic_tag === 'admin';
                            }).map(function (nic) {
                                return nic.ip;
                            })[0];

                            if (adminIp) {
                                vmDetails.ip = adminIp;
                            }

                            insts.push(vmDetails);
                            nextVm();
                        });
                    }
                }, next);
            });
        }
    ]}, function (err) {
        cb(err, insts);
    });
};


/**
 * Gather a JSON object for each installed SDC service.
 *
 * "Services" include: SDC core vms and agents.
 */
SdcAdm.prototype.getServices = function getServices(opts, cb) {
    var self = this;
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    var app;
    var svcs = [];
    vasync.pipeline({funcs: [
        function getSdcApp(_, next) {
            self.sapi.listApplications({name: 'sdc'}, function (appErr, app_) {
                if (appErr) {
                    return next(new errors.SDCClientError(appErr, 'sapi'));
                }
                app = (app_ && app_.length > 0 ? app_[0] : null);
                next();
            });
        },
        function getSapiSvcs(_, next) {
            // 'cloudapi' zones typically don't have `tags.smartdc_core=true`
            // so we can't filter on that. And VMAPI doesn't support filtering
            // on presence of a tag (e.g. `smartdc_role`.)
            var filters = {
                application_uuid: app.uuid
            };
            self.sapi.listServices(filters, function (svcsErr, svcs_) {
                if (svcsErr) {
                    return next(new errors.SDCClientError(svcsErr, 'sapi'));
                }
                svcs = svcs_;
                var haveAssets = false;
                svcs.forEach(function (svc) {
                    // TODO(trent): want SAPI to have this eventually
                    svc.type = 'vm';
                    if (svc.name === 'assets') {
                        haveAssets = true;
                    }
                });
                // TODO: get assets service in SAPI. Hack it in for now.
                // Not having 'assets' service mucks up update type guessing
                // in 'sdcadm update assets', for example.
                if (!haveAssets) {
                    svcs.push({
                        type: 'vm',
                        name: 'assets'
                    });
                }

                next();
            });
        },
        function getAgents(_, next) {
            // TODO: Remove these hardcoded values
            // Hardcode "known" agents for now until SAPI handles agents.
            // Excluding "marlin". Should we include hagfish-watcher?
            [
                {
                  'name': 'cabase'
                },
                {
                  'name': 'hagfish-watcher'
                },
                {
                  'name': 'agents_core'
                },
                {
                  'name': 'firewaller'
                },
                {
                  'name': 'amon-agent'
                },
                {
                  'name': 'cainstsvc'
                },
                {
                  'name': 'provisioner'
                },
                {
                  'name': 'amon-relay'
                },
                {
                  'name': 'heartbeater'
                },
                {
                  'name': 'smartlogin'
                },
                {
                  'name': 'zonetracker'
                }
            ].forEach(function (agent) {
                agent.type = 'agent';
                svcs.push(agent);
            });
            next();
        }
    ]}, function (err) {
        cb(err, svcs);
    });
};


/**
 * Get the full image object for the given image UUID from either the local
 * IMGAPI or the updates server.
 *
 * @param options {Object} Required.
 *      - uuid {UUID} Required. The image uuid.
 * @param cb {Function} `function (err, img)`
 */
SdcAdm.prototype.getImage = function getImage(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.func(cb, 'cb');
    var self = this;

    self.imgapi.getImage(opts.uuid, function (iErr, iImg) {
        if (iErr && iErr.body && iErr.body.code === 'ResourceNotFound') {
            self.updates.getImage(opts.uuid, cb);
        } else {
            cb(iErr, iImg);
        }
    });
};


/*
 * Fetch a given agent installer image (or if desired, latest), download it,
 * then use /usbkey/scripts/update_agents to deploy the installer to compute
 * nodes.
 */
SdcAdm.prototype.updateAgents =
function updateAgents(options, callback) {
    assert.object(options, 'options');
    assert.string(options.image, 'options.image');
    assert.func(options.progress, 'opts.progress');

    var self = this;
    var localdir = '/var/tmp';
    var deleteOnFinish = true;
    var filepath;
    var image;
    var progress = options.progress;

    vasync.pipeline({funcs: [
        function (_, next) {
            // Check if the value of the parameter `image` is a file
            if (fs.existsSync(options.image)) {
                filepath = options.image;
                deleteOnFinish = false;
                next();
            } else if (options.image === 'latest') {
                findInstallerImageLatest(next);
            } else {
                findInstallerImageByUuid(next);
            }
        },
        function (_, next) {
            if (filepath) {
                progress('Using agent installer file %s', filepath);
                next();
            } else {
                filepath = format('%s/agents-%s-%d.sh',
                                  localdir, image.uuid, process.pid);
                downloadInstallerImage(next);
            }
        },
        function (_, next) {
            executeInstallerFile(next);
        },
        function (_, next) {
            if (deleteOnFinish) {
                cleanup(next);
            } else {
                next();
            }
        }
    ]}, function (err) {
        callback(err);
    });

    function findInstallerImageLatest(cb) {
        var filter = {
            name: 'agentsshar'
        };
        self.updates.listImages(filter, function (err, images) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            if (Array.isArray(images) && !images.length) {
                return cb(new errors.UpdateError('no images found'));
            }
            common.sortArrayOfObjects(images, ['published_at']);
            image = images[images.length-1];

            cb();
        });
        return;
    }

    function findInstallerImageByUuid(cb) {
        self.updates.getImage(options.image, function (err, foundImage) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            image = foundImage;
            cb();
        });
    }

    function downloadInstallerImage(cb) {
        progress('Downloading agentsshar image %s (%s) to %s', image.uuid,
            image.version, filepath);
        self.updates.getImageFile(image.uuid, filepath, onImage);

        function onImage(err) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            cb();
        }
    }

    function executeInstallerFile(cb) {
        var argv = [
            '/usbkey/scripts/update_agents',
            filepath
        ];
        progress('Executing agents installer across datacenter');
        common.execFilePlus({argv: argv, log: self.log}, cb);
    }

    function cleanup(cb) {
        fs.unlink(filepath, function (err) {
            if (err) {
                self.log.warn(err, 'unlinking %s', filepath);
            }
            cb();
        });
    }
};

/**
 * Fetch a given platform image (or if desired, latest), download it,
 * then use /usbkey/scripts/install-platform.sh to add to list of available
 * platforms from which to boot compute nodes
 */
SdcAdm.prototype._installPlatform =
function _installPlatform(options, callback) {
    assert.object(options, 'options');
    assert.string(options.image, 'options.image');
    assert.func(options.progress, 'opts.progress');

    var self = this;
    var localdir = '/var/tmp';
    var deleteOnFinish = true;
    var filepath;
    var image;
    var progress = options.progress;

    vasync.pipeline({funcs: [
        function (_, next) {
            // Check if the value of the parameter `image` is a file
            if (fs.existsSync(options.image)) {
                filepath = options.image;
                deleteOnFinish = false;
                return next();
            } else if (options.image === 'latest') {
                return findPlatformImageLatest(next);
            } else if (options.image.match(
                /([a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}?)/ig))
            {
                return findPlatformImageByUuid(next);
            } else {
                return findPlatformBySearching(next);
            }
        },
        function (_, next) {
            if (filepath) {
                progress(format('Using platform file %s', filepath));
                next();
            } else {
                filepath = format('%s/platform-%s.tgz',
                                  localdir, image.version);
                downloadPlatformImage(next);
            }
        },
        function (_, next) {
            executeInstallerFile(next);
        }
    ]}, function (err) {
        if (err) {
            progress('Error: %s', err.message);
            progress('In order not to have to re-download image, ' +
                     '%s has been left behind.', filepath);
            progress('After correcting above problem, rerun ' +
                     '`install-platform` with platform image %s', filepath);
            return callback(err);
        }

        if (deleteOnFinish) {
            return cleanup(callback);
        } else {
            progress('Platform image explicitly specified; ' +
                     'will not delete %s', filepath);
        }

        progress('Installation complete');

        callback();
    });

    function findPlatformImageLatest(cb) {
        var filter = {
            name: 'platform'
        };
        self.updates.listImages(filter, function (err, images) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            if (Array.isArray(images) && !images.length) {
                return cb(new errors.UpdateError('no images found'));
            }
            common.sortArrayOfObjects(images, ['published_at']);
            image = images[images.length-1];

            cb();
        });
        return;
    }

    function findPlatformImageByUuid(cb) {
        self.updates.getImage(options.image, function (err, foundImage) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            image = foundImage;
            cb();
        });
    }

    function findPlatformBySearching(cb) {
        var filter = {
            name: 'platform',
            version: '~' + '-' + options.image
        };
        self.updates.listImages(filter, function (err, images) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            if (Array.isArray(images) && !images.length) {
                return cb(new errors.UpdateError('no images found'));
            }
            common.sortArrayOfObjects(images, ['published_at']);
            image = images[images.length-1];

            cb();
        });
        return;
    }

    function downloadPlatformImage(cb) {
        progress(format(
            'Downloading platform image %s (%s) to %s', image.uuid,
            image.version, filepath));
        self.updates.getImageFile(image.uuid, filepath, onImage);

        function onImage(err) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            cb();
        }
    }

    function executeInstallerFile(cb) {
        progress(format('Installing platform image onto USB key'));
        var INSTALL_PLATFORM = '/usbkey/scripts/install-platform.sh';
        var child = spawn(
            INSTALL_PLATFORM, [ filepath ],
            { stdio: 'inherit' });

        child.on('exit', function (code) {
            if (code) {
                return cb(new Error(INSTALL_PLATFORM + ' returned ' + code));
            }
            cb();
        });
    }

    function cleanup(cb) {
        fs.unlink(filepath, function (err) {
            if (err) {
                self.log.warn(err, 'unlinking %s', filepath);
            }
            cb();
        });
    }
};


/*
 * Fetch a given gz-tools tarball image (or if desired, latest), download it,
 * then do the following:
 *
 * - Update SDC zone tools (tools.tar.gz)
 * - Update GZ scripts
 * - Update /usbkey/default
 * - Update cn_tools.tar.gz on all Compute Nodes
 */
SdcAdm.prototype.updateGzTools = function updateGzTools(options, callback) {
    assert.object(options, 'options');
    assert.string(options.image, 'options.image');
    assert.func(options.progress, 'opts.progress');

    var self = this;
    var localdir = '/var/tmp';
    var deleteOnFinish = true;
    var filepath;
    var image;
    var sdcZone;
    var progress = options.progress;
    var timestamp = Math.floor(new Date().getTime() / 1000);
    var tmpToolsDir = format('%s/gz-tools', localdir);

    vasync.pipeline({funcs: [
        function findImage(_, next) {
            // Check if the value of the parameter `image` is a file
            if (fs.existsSync(options.image)) {
                filepath = options.image;
                deleteOnFinish = false;
                next();
            } else if (options.image === 'latest') {
                findTarballImageLatest(next);
            } else {
                findTarballImageByUuid(next);
            }
        },
        function ensureSdcInstance(_, next) {
            var filters = {
                state: 'active',
                owner_uuid: self.config.ufds_admin_uuid,
                'tag.smartdc_role': 'sdc'
            };
            self.vmapi.listVms(filters, function (vmsErr, vms) {
                if (vmsErr) {
                    return next(vmsErr);
                }
                if (Array.isArray(vms) && !vms.length) {
                    return next(new errors.UpdateError('no "sdc" VM instance '
                        + 'found'));
                }
                sdcZone = vms[0];
                return next();
            });
        },
        function downloadTarball(_, next) {
            if (filepath) {
                progress('Using gz-tools tarball file %s', filepath);
                next();
            } else {
                if (image.name !== 'gz-tools' && !options.force) {
                    callback(new errors.UsageError(
                        'name of image by given uuid is not \'gz-tools\''));
                }
                filepath = format('%s/gz-tools-%s-%d.tgz',
                                  localdir, image.uuid, process.pid);

                downloadTarballImage(next);
            }
        },
        function decompressTarball(_, next) {
            var argv = [
                '/usr/bin/tar',
                'xzvof',
                filepath,
                '-C', localdir
            ];

            progress('Decompressing gz-tools tarball');
            common.execFilePlus({argv: argv, log: self.log}, next);
        },
        function (_, next) {
            updateSdcFiles(next);
        },
        function (_, next) {
            updateScripts(next);
        },
        function (_, next) {
            updateCnTools(next);
        },
        function (_, next) {
            if (deleteOnFinish) {
                cleanup(next);
            } else {
                next();
            }
        }
    ]}, function (err) {
        callback(err);
    });

    function findTarballImageLatest(cb) {
        var filter = {
            name: 'gz-tools'
        };
        self.updates.listImages(filter, function (err, images) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            if (Array.isArray(images) && !images.length) {
                return cb(new errors.UpdateError('no images found'));
            }
            common.sortArrayOfObjects(images, ['published_at']);
            image = images[images.length-1];

            cb();
        });
        return;
    }

    function findTarballImageByUuid(cb) {
        self.updates.getImage(options.image, function (err, foundImage) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            image = foundImage;
            cb();
        });
    }

    function downloadTarballImage(cb) {
        progress('Downloading gz-tools image %s (%s) to %s', image.uuid,
            image.version, filepath);
        self.updates.getImageFile(image.uuid, filepath, onImage);

        function onImage(err) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            cb();
        }
    }

    function updateSdcFiles(cb) {
        progress('Updating "sdc" zone tools');
        vasync.pipeline({funcs: [
            function removeSymlink(_, next) {
                var argv = ['rm', '-rf', '/opt/smartdc/sdc'];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },
            function reSymlink(_, next) {
                var argv = [
                    'ln', '-s',
                    '/zones/' + sdcZone.uuid + '/root/opt/smartdc/sdc',
                    '/opt/smartdc/sdc'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },
            function decompressTools(_, next) {
                // tools.tar.gz will be located at $tmpToolsDir/tools.tar.gz
                var argv = [
                    '/usr/bin/tar',
                    'xzof',
                    tmpToolsDir + '/tools.tar.gz',
                    '-C', '/opt/smartdc'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },
            function cleanupSemverFile(_, next) {
                // Remove semver.js from an old sdc-clients-light version
                var sverFile = '/opt/smartdc/node_modules/sdc-clients/' +
                    'node_modules/semver.js';

                if (!fs.existsSync(sverFile)) {
                    next();
                    return;
                }

                fs.unlink(sverFile, function (err) {
                    if (err) {
                        self.log.warn(err, 'unlinking %s', sverFile);
                    }
                    next();
                });
            }
        ]}, function (err) {
            cb(err);
        });
    }

    function updateScripts(cb) {
        progress('Updating global zone scripts');
        vasync.pipeline({funcs: [
            function mountUsbKey(_, next) {
                progress('Mounting USB key');
                var argv = ['/usbkey/scripts/mount-usb.sh'];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function (_, next) {
                var argv = [
                    'cp', '-Rp',
                    '/usbkey/scripts',
                    localdir + '/pre-upgrade.scripts.' + timestamp
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function (_, next) {
                var argv = [
                    'rm', '-rf',
                    '/mnt/usbkey/scripts /usbkey/scripts'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function (_, next) {
                var argv = [
                    'cp', '-Rp',
                    tmpToolsDir + '/scripts',
                    '/mnt/usbkey/'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function (_, next) {
                var argv = [
                    'cp', '-Rp',
                    tmpToolsDir + '/scripts',
                    '/usbkey/'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function (_, next) {
                var argv = [
                    'cp',
                    tmpToolsDir + '/scripts/joysetup.sh',
                    '/usbkey/extra/joysetup/'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function (_, next) {
                var argv = [
                    'cp',
                    tmpToolsDir + '/scripts/agentsetup.sh',
                    '/usbkey/extra/joysetup/'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function (_, next) {
                if (!fs.existsSync('/usbkey/tools.tar.gz')) {
                    next();
                    return;
                }
                var argv = [
                    'cp',
                    '/usbkey/tools.tar.gz',
                    localdir + '/pre-upgrade.tools.' + timestamp + '.tar.gz'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function (_, next) {
                var argv = [
                    'cp',
                    tmpToolsDir + '/tools.tar.gz',
                    '/usbkey/tools.tar.gz'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function (_, next) {
                var argv = [
                    'cp',
                    tmpToolsDir + '/tools.tar.gz',
                    '/mnt/usbkey/tools.tar.gz'
                ];
                common.execFilePlus({argv: argv, log: self.log}, next);
            },

            function (_, next) {
                var cmd = ['cp', tmpToolsDir + '/default/*',
                    '/mnt/usbkey/default'];

                exec(cmd.join(' '), function (err, stdout, stderr) {
                    self.log.trace({cmd: cmd, err: err, stdout: stdout,
                        stderr: stderr}, 'ran cp command');
                    if (err) {
                        return next(new errors.InternalError({
                            message: 'error running cp command',
                            cmd: cmd,
                            stdout: stdout,
                            stderr: stderr,
                            cause: err
                        }));
                    }
                    next();
                });
            },

            function (_, next) {
                var cmd = ['cp', tmpToolsDir + '/default/*',
                    '/usbkey/default'];

                exec(cmd.join(' '), function (err, stdout, stderr) {
                    self.log.trace({cmd: cmd, err: err, stdout: stdout,
                        stderr: stderr}, 'ran cp command');
                    if (err) {
                        return next(new errors.InternalError({
                            message: 'error running cp command',
                            cmd: cmd,
                            stdout: stdout,
                            stderr: stderr,
                            cause: err
                        }));
                    }
                    next();
                });
            },

            function unmountUsbKey(_, next) {
                progress('Unmounting USB key');
                var argv = ['/usr/sbin/umount', '/mnt/usbkey'];
                common.execFilePlus({argv: argv, log: self.log}, next);
            }
        ]}, function (err) {
            cb(err);
        });
    }

    function updateCnTools(cb) {
        progress('Updating cn_tools on all compute nodes');

        var argv = [
            '/usbkey/scripts/update_cn_tools', '-f',
            tmpToolsDir + '/cn_tools.tar.gz'
        ];
        common.execFilePlus({argv: argv, log: self.log}, cb);
    }

    function cleanup(cb) {
        progress('Cleaning up gz-tools tarball');
        fs.unlink(filepath, function (err) {
            if (err) {
                self.log.warn(err, 'unlinking %s', filepath);
            }
            cb();
        });
    }
};


/**
 * Assigns a new platform to a compute node and ensures all necessary
 * post-assign steps are performed.
 */

SdcAdm.prototype._assignPlatform =
function _assignPlatform(options, callback) {
    var self = this;
    assert.object(options, 'options');
    assert.optionalBool(options.all, 'options.all');
    assert.string(options.platform, 'options.platform');
    assert.optionalString(options.server, 'options.server');
    assert.func(options.progress, 'opts.progress');

    if (!options.all && !options.server) {
        return callback(new Error('must specify a SERVER or --all'));
    }

    var serverRecs = [];
    var assignServers = [];
    var headnode;
    var progress = options.progress;

    vasync.pipeline({funcs: [
        function validatePlatform(_, next) {
            self.cnapi.listPlatforms(function (err, platforms) {
                if (err) {
                    return next(err);
                }
                if (Object.keys(platforms).indexOf(options.platform) === -1) {
                    return callback(
                        new Error(format(
                            'invalid platform %s', options.platform)));
                }
                progress('platforms');
                progress(platforms);

                next();
            });
        },
        function (_, next) {
            self.cnapi.listServers(function (err, recs) {
                if (err) {
                    return next(err);
                }
                serverRecs = recs;

                next();
            });
        },
        function (_, next) {
            // Find the headnode and depending on the options passed in,
            // either a single compute node or multiple. We need the headnode
            // details so that we can update the booter cache on the headnode
            // dhcpd zone.
            serverRecs.forEach(function (server) {
                if (server.headnode === true) {
                    headnode = server;
                }

                if (options.all) {
                    assignServers.push(server);
                } else if (options.server === server.hostname ||
                    options.server === server.uuid)
                {
                    assignServers = [server];
                }
            });

            if (options.server && !assignServers.length) {
                return next(
                    new Error(format(
                        'server %s not found', options.server)));
            }

            next();
        },
        function (_, next) {

            var assignQueue = vasync.queue(
                doAssignServerPlatform, 5);

            assignQueue.once('end', next);

            assignQueue.push(assignServers);
            assignQueue.close();

            function doAssignServerPlatform(server, nextServer) {
                if (server.headnode) {
                    return assignForHeadnode(server, nextServer);
                } else {
                    return assignForComputenode(server, nextServer);
                }
            }
        },
        function doUpdateBooterCache(_, next) {
            updateBooterCache(assignServers, next);
        }
    ]},
    function (err) {
        callback(err);
    });

    function assignForHeadnode(server, cb) {
        vasync.pipeline({funcs: [
            function doSwitchPlatform(_, next) {
                progress(
                    'updating headnode %s to %s',
                    server.uuid, options.platform);

                var script = format(
                    '#!/bin/bash\n' +
                    'export PATH=$PATH:/usr/bin:/usr/sbin:/opt/smartdc/bin/\n' +
                    '/usbkey/scripts/switch-platform.sh %s\n' +
                    'cd /usbkey/os\n' +
                    'rm latest; ln -s %s latest',
                    options.platform, options.platform);

                self.cnapi.commandExecute(server.uuid, script, {}, next);
            },
            function doSetBootParams(_, next) {
                progress('Setting boot params for %s', server.uuid);
                self.cnapi.setBootParams(
                    server.uuid, { platform: options.platform }, {}, next);
            }
        ]}, function (err) {
            cb(err);
        });
    }

    function assignForComputenode(server, cb) {
        progress(
            'updating computenode %s to %s',
            server.uuid, options.platform);

        progress('Setting cn boot params for %s', server.uuid);
        self.cnapi.setBootParams(
            server.uuid, { platform: options.platform }, {}, cb);
    }

    function updateBooterCache(servers, cb) {
        var macs;
        var serveruuids = servers.map(function (server) {
            return server.uuid;
        });

        progress('Updating booter cache for servers');

        vasync.pipeline({funcs: [
            function (_, next) {
                var listOpts = {
                    belongs_to_type: 'server',
                    nic_tags_provided: 'admin'
                };
                if (!options.all) {
                    listOpts.belongs_to_uuid = serveruuids;
                }
                self.napi.listNics(listOpts, {}, function (err, nics) {
                    if (err) {
                        return cb(err);
                    }

                    macs = nics.map(function (nic) { return nic.mac; });

                    next();
                });
            },
            function (_, next) {
                var script = format(
                    '#!/bin/bash\n' +
                    'export PATH=$PATH:/usr/bin:/usr/sbin:/opt/smartdc/bin/\n' +
                    'cat <<EOF> /var/tmp/macs.$$;\n' +
                    macs.join('\n') + '\n' +
                    'EOF\n' +
                    'cat /var/tmp/macs.$$ ' +
                    '    | sdc-login dhcpd "' +
                    '       xargs -n 1 ' +
                    '           /opt/smartdc/booter/bin/booter bootparams"\n' +
                    'rm /var/tmp/macs.$$\n'
                );


                self.cnapi.commandExecute(headnode.uuid, script, {}, next);
            }
        ]}, function (err) {
            progress('Done updating booter caches');
            cb();
        });
    }
};


/**
 * Return an array of candidate images (the full image objects) for a
 * give service update. If available, the oldest current instance image is
 * included.
 *
 * TODO: support this for a particular instance as well by passing in `inst`.
 *
 * @param options {Object} Required.
 *      - service {Object} Required. The service object as from `getServices()`.
 *      - insts {Array} Required. Current DC instances as from `getInstances()`.
 * @param cb {Function} `function (err, img)`
 */
SdcAdm.prototype.getCandidateImages = function getCandidateImages(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.service, 'opts.service');
    assert.arrayOfObject(opts.insts, 'opts.insts');
    assert.func(cb, 'cb');
    var self = this;

    var currImgs = [];
    var imgs;

    vasync.pipeline({funcs: [
        function getCurrImgs(_, next) {
            var currImgUuids = {};
            opts.insts.forEach(function (inst) {
                if (inst.service === opts.service.name) {
                    currImgUuids[inst.image] = true;
                }
            });
            currImgUuids = Object.keys(currImgUuids);
            if (currImgUuids.length === 0) {
                // No insts -> use the image_uuid set on the service.
                assert.ok(opts.service.params.image_uuid,
                    'service object has no "params.image_uuid": '
                    + JSON.stringify(opts.service));
                currImgUuids.push(opts.service.params.image_uuid);
            }

            self.log.debug({currImgUuids: currImgUuids},
                'getCandidateImages: getCurrImgs');
            vasync.forEachParallel({inputs: currImgUuids, func:
                function getImg(imgUuid, nextImg) {
                    self.getImage({uuid: imgUuid}, function (iErr, img) {
                        if (iErr && iErr.body &&
                            iErr.body.code === 'ResourceNotFound')
                        {
                            /**
                             * Don't error out for those weird cases where
                             * (a) the image was removed from local imgapi; and
                             * (b) is so old it isn't in the updates server.
                             */
                            nextImg();
                        } else if (iErr) {
                            nextImg(iErr);
                        } else {
                            currImgs.push(img);
                            nextImg();
                        }
                    });
                }
            }, next);
        },

        function getCandidates(_, next) {
            /**
             * Which images to consider for an update? Consider a service with
             * 3 instances at image versions A, A and C. (Note that
             * `published_at` is the field used to order images with the
             * same name.)
             *
             * Ideally we allow 'B', 'C' and anything after 'C' as candidate
             * updates. So we'll look for images published after 'A'
             * (including 'A' to allow same-image updates for dev/testing).
             */
            common.sortArrayOfObjects(currImgs, ['published_at']);
            var filter = {
                name: self.config.imgNameFromSvcName[opts.service.name],
                // For now just master builds. This is a limitation b/c
                // *feature* branch builds currently get into the 'dev'
                // channel on updates.joyent.com. See TOOLS-684.
                version: '~master',
                marker: (currImgs.length > 0 ? currImgs[0].uuid : undefined)
            };

            self.log.debug({filter: filter},
                'getCandidateImages: getCandidates');
            self.updates.listImages(filter, function (uErr, followingImgs) {
                if (uErr) {
                    return next(uErr);
                }
                if (currImgs.length > 0) {
                    imgs = [currImgs[0]].concat(followingImgs);
                } else {
                    imgs = followingImgs;
                }
                next();
            });
        }
    ]}, function done(err) {
        cb(err, imgs);
    });
};


SdcAdm.prototype.acquireLock = function acquireLock(opts, cb) {
    assert.object(opts, 'opts');
    assert.func(opts.progress, 'opts.progress');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;

    var acquireLogTimeout = setTimeout(function () {
        opts.progress('Waiting for sdcadm lock');
    }, 1000);
    log.debug({lockPath: self._lockPath}, 'acquire lock');
    lock(self._lockPath, function (lockErr, unlock) {
        if (acquireLogTimeout) {
            clearTimeout(acquireLogTimeout);
        }
        if (lockErr) {
            cb(new errors.InternalError({
                message: 'error acquiring lock',
                lockPath: self._lockPath,
                cause: lockErr
            }));
            return;
        }
        log.debug({lockPath: self._lockPath}, 'acquired lock');
        cb(null, unlock);
    });
};

SdcAdm.prototype.releaseLock = function releaseLock(opts, cb) {
    assert.object(opts, 'opts');
    assert.func(opts.unlock, 'opts.unlock');
    assert.func(cb, 'cb');
    var self = this;
    var log = this.log;

    if (!opts.unlock) {
        return cb();
    }
    log.debug({lockPath: self._lockPath}, 'releasing lock');
    opts.unlock(function (unlockErr) {
        if (unlockErr) {
            cb(new errors.InternalError({
                message: 'error releasing lock',
                lockPath: self._lockPath,
                cause: unlockErr
            }));
            return;
        }
        log.debug({lockPath: self._lockPath}, 'released lock');
        cb();
    });
};



/**
 * Generate an update plan according to the given changes.
 * The caller should be holding a `<SdcAdm>.acquireLock()`.
 *
 * `changes` is an array of objects of the following form:
 *
 * 1. create-instance: 'type:create-instance' and 'service' and 'server'
 * 2. agent delete-instance:
 *          'type:delete-instance' and 'service' and 'server'
 *    or
 *          'type:delete-instance' and 'instance'
 *    Where 'instance' for an agent is '$server/$service', e.g.
 *    'c26c3aba-405b-d04b-b51d-5a68d8f950d7/provisioner'.
 * 3. vm delete-instance: 'type:delete' and 'instance' (the VM uuid or alias)
 * 4. delete-service: 'type:delete-service' and 'service'
 * 5. vm update-instance: 'instance', optional 'type:update-instance'
 * 6. agent update-instance:
 *          'service' and 'server'
 *    or
 *          'instance'
 *    with optional 'type:update-instance'.
 * 7. update-service: 'service', optional 'type:update-service'.
 *
 * Except for 'delete-service', 'image' is optional for all, otherwise the
 * latest available image is implied.
 *
 * @param options {Object}  Required.
 *      - changes {Array} Required. The update spec array of objects.
 *      - progress {Function} Optional. A function that is called
 *        with progress messages. Called like printf, i.e. passing in
 *        `console.log` or a Bunyan `log.info.bind(log)` is fine.
 *      - forceRabbitmq {Boolean} Optional. Allow rabbitmq to be updated, as it
 *        will not be by default
 *      - forceSameImage {Boolean} Optional. Allow an update to proceed even
 *        if the target image is the same as that of the current instance(s).
 *      - justImages {Boolean} Optional. Generate a plan that just imports
 *        the images. Default false.
 *      - updateAll {Boolean} Optional. genUpdatePlan will produce a less noisy
 *        output when updating all existing instances. Default false.
 * @param cb {Function} Callback of the form `function (err, plan)`.
 */
SdcAdm.prototype.genUpdatePlan = function genUpdatePlan(options, cb) {
    assert.object(options, 'options');
    assert.arrayOfObject(options.changes, 'options.changes');
    assert.optionalFunc(options.progress, 'options.progress');
    assert.optionalBool(options.justImages, 'options.justImages');
    assert.optionalBool(options.updateAll, 'options.updateAll');
    assert.optionalBool(options.forceRabbitmq, 'options.forceRabbitmq');
    assert.optionalBool(options.forceSameImage, 'options.forceSameImage');
    assert.optionalString(options.uuid, 'options.uuid');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    var progress = options.progress || function () {};
    var justImages = Boolean(options.justImages);
    var updateAll = Boolean(options.updateAll);

    var changes = common.deepObjCopy(options.changes);
    var servers;
    var serverFromUuidOrHostname;
    var svcs;
    var svcFromName;
    var insts;
    var plan;
    vasync.pipeline({funcs: [
        /**
         * Basic validation of keys of the changes. Validation of values is
         * later.
         */
        function validateChanges(_, next) {
            var errs = [];
            for (var i = 0; i < changes.length; i++) {
                var change = changes[i];
                var repr = JSON.stringify(change);
                if (change.image) {
                    validateString(change.image, '"image" in ' + repr);
                }
                if (change.type === 'create') {
                    // 1. create-instance
                    validateString(change.service, '"service" in ' + repr);
                    validateString(change.server, '"server" in ' + repr);
                    validateKeys(['type', 'server', 'service', 'image'],
                        change, repr);
                } else if (change.type === 'delete' && change.service &&
                        change.server) {
                    // 2. agent delete-instance
                    validateString(change.service, '"service" in ' + repr);
                    validateString(change.server, '"server" in ' + repr);
                    validateKeys(['type', 'server', 'service', 'image'],
                        change, repr);
                } else if (change.type === 'delete') {
                    // 2. agent delete-instance
                    // 3. vm delete-instance
                    validateString(change.instance, '"instance" in ' + repr);
                    validateKeys(['type', 'instance', 'image'], change, repr);
                } else if (change.type === 'delete-service') {
                    // 4. delete-service
                    validateString(change.service, '"service" in ' + repr);
                    validateKeys(['type', 'service'], change, repr);
                } else if (change.service && change.server) {
                    // 6. agent update-instance
                    if (change.type && change.type !== 'update-instance') {
                        errs.push(new errors.ValidationError(
                            'invalid type "update-instance" change in ' +
                            repr));
                    } else {
                        change.type = 'update-instance';
                    }
                    validateString(change.service, '"service" in ' + repr);
                    validateString(change.server, '"server" in ' + repr);
                    validateKeys(['type', 'server', 'service', 'image'],
                        change, repr);
                } else if (change.instance) {
                    // 5. vm update-instance
                    // 6. agent update-instance
                    if (change.type && change.type !== 'update-instance') {
                        errs.push(new errors.ValidationError(
                            'invalid type "update-instance" change in ' +
                            repr));
                    } else {
                        change.type = 'update-instance';
                    }
                    validateString(change.instance, '"instance" in ' + repr);
                    validateKeys(['type', 'instance', 'image'], change, repr);
                } else if (change.service) {
                    // 7. update-service
                    if (change.type && change.type !== 'update-service') {
                        errs.push(new errors.ValidationError(
                            'invalid type "update-service" change in ' +
                            repr));
                    } else {
                        change.type = 'update-service';
                    }
                    validateString(change.service, '"service" in ' + repr);
                    validateKeys(['type', 'service', 'image'], change, repr);
                } else {
                    errs.push(new errors.ValidationError(
                        'invalid change: ' + repr));
                }
            }
            if (errs.length === 1) {
                next(errs[0]);
            } else if (errs.length > 1) {
                next(new errors.MultiError(errs));
            } else {
                next();
            }

            function validateString(value, msg) {
                if (typeof (value) !== 'string') {
                    errs.push(new errors.ValidationError(
                        msg + ' (string) is required'));
                }
            }
            function validateKeys(allowed, change_, repr_) {
                var extraKeys = Object.keys(change_).filter(function (k) {
                    return !~allowed.indexOf(k);
                });
                if (extraKeys.length) {
                    errs.push(new errors.ValidationError(format(
                        'invalid extra fields "%s" in %s',
                        extraKeys.join('", "'), repr_)));
                }
            }
        },

        function getServers(_, next) {
            self.cnapi.listServers(function (err, servers_) {
                servers = servers_ || [];
                serverFromUuidOrHostname = {};
                for (var i = 0; i < servers.length; i++) {
                    serverFromUuidOrHostname[servers[i].uuid] = servers[i];
                    serverFromUuidOrHostname[servers[i].hostname] = servers[i];
                }
                next(err);
            });
        },

        function getSvcs(_, next) {
            self.getServices({}, function (err, svcs_) {
                svcs = svcs_ || [];
                svcFromName = {};
                for (var i = 0; i < svcs.length; i++) {
                    svcFromName[svcs[i].name] = svcs[i];
                }
                next(err);
            });
        },

        function getInsts(_, next) {
            self.getInstances({}, function (err, insts_) {
                insts = insts_;
                next(err);
            });
        },

        /**
         * Normalize fields in each change in the `changes` array from the
         * convenience inputs (e.g. service="imgapi") to full details
         * (e.g. service=<the full imgapi SAPI service object>).
         */
        function normalizeChanges(_, next) {
            if (updateAll) {
                var serviceNames = changes.map(function (ch) {
                    return ch.service;
                }).join(', ');

                progress('Finding candidate update images for %s '
                    + 'services (%s).', changes.length, serviceNames);
            }

            vasync.forEachParallel({inputs: changes, func:
                function resolveChange(ch, nextChange) {
                    var changeRepr = JSON.stringify(ch);
                    var i, found;
                    if (ch.service) {
                        if (!svcFromName[ch.service]) {
                            return nextChange(new errors.UpdateError(format(
                                'unknown service "%s" from %s', ch.service,
                                changeRepr)));
                        } else {
                            ch.service = svcFromName[ch.service];
                        }
                    }
                    if (ch.uuid) {
                        found = false;
                        for (i = 0; i < insts.length; i++) {
                            if (insts[i].uuid === ch.uuid) {
                                ch.instance = insts[i];
                                found = true;
                                break;
                            }
                        }
                        if (!found) {
                            return nextChange(new errors.UpdateError(format(
                                'unknown SDC instance uuid "%s" from %s',
                                ch.uuid, changeRepr)));
                        }
                    } else if (ch.alias) {
                        found = false;
                        for (i = 0; i < insts.length; i++) {
                            if (insts[i].alias === ch.alias) {
                                ch.instance = insts[i];
                                found = true;
                                break;
                            }
                        }
                        if (!found) {
                            return nextChange(new errors.UpdateError(format(
                                'unknown SDC instance alias "%s" from %s',
                                ch.alias, changeRepr)));
                        }
                    }
                    if (!ch.service) {
                        p('TODO instance (what is service?):', ch.instance, ch);
                        throw new Error('TODO');
                        // ch.server = TODO;
                    }
                    if (ch.server) {
                        found = false;
                        for (i = 0; i < servers.length; i++) {
                            if (servers[i].uuid === ch.server ||
                                servers[i].hostname === ch.server)
                            {
                                found = true;
                                break;
                            }
                        }
                        if (!found) {
                            return nextChange(new errors.UpdateError(format(
                                'unknown SDC server "%s" from %s',
                                ch.server, changeRepr)));
                        }
                    }

                    // All candidate images to `ch.images`. Just the single
                    // image if one was specified.
                    if (ch.image) {
                        self.getImage({uuid: ch.image}, function (iErr, img) {
                            if (iErr) {
                                return nextChange(new errors.UpdateError(
                                    iErr,
                                    format('unknown image "%s" from %s',
                                        ch.image, changeRepr)));
                            }
                            ch.images = [img];
                            delete ch.image;
                            nextChange();
                        });
                    } else {
                        if (!updateAll) {
                            progress('Finding candidate update images '
                                + 'for the "%s" service.', ch.service.name);
                        }
                        self.getCandidateImages({
                            service: ch.service,
                            insts: insts
                        }, function (iErr, imgs) {
                            if (iErr) {
                                return nextChange(new errors.InternalError({
                                    cause: iErr,
                                    message: 'error finding candidate '
                                        + 'images for ' + changeRepr
                                }));
                            }
                            ch.images = imgs;
                            log.debug({serviceName: ch.service.name},
                                '%d candidate images (including current)',
                                imgs.length);
                            nextChange();
                        });
                    }
                }
            }, next);
        },

        /**
         * Kinds of conflicts:
         * - action on a service *and* an instance of the same service
         * - two actions on the same service
         * - two actions on the same instance
         */
        function checkForConflictingChanges(_, next) {
            function reprFromChange(ch_) {
                return JSON.stringify({
                    type: ch_.type,
                    service: ch_.service.name,
                    instance: ch_.instance && ch_.instance.instance
                });
            }

            var changeFromSvc = {};
            var changeFromInst = {};
            var i, ch, typeTarg, svc;
            for (i = 0; i < changes.length; i++) {
                ch = changes[i];
                // e.g. 'update-service' -> 'service'
                typeTarg = ch.type.split('-')[1];
                if (typeTarg === 'service') {
                    svc = ch.service.name;
                    if (changeFromSvc[svc]) {
                        return next(new errors.UpdateError(format(
                            'conflict: cannot make multiple changes to the ' +
                            'same service: %s and %s', reprFromChange(ch),
                            reprFromChange(changeFromSvc[svc]))));
                    }
                    changeFromSvc[svc] = ch;
                } else {
                    assert.equal(typeTarg, 'instance');
                    var inst = ch.instance.instance;
                    if (changeFromInst[inst]) {
                        return next(new errors.UpdateError(format(
                            'conflict: cannot make multiple changes to the ' +
                            'same instance: %s and %s', reprFromChange(ch),
                            reprFromChange(changeFromInst[inst]))));
                    }
                    changeFromInst[inst] = ch;
                }
            }
            for (i = 0; i < changes.length; i++) {
                ch = changes[i];
                typeTarg = ch.type.split('-')[1];
                if (typeTarg === 'instance') {
                    svc = ch.service.name;
                    if (changeFromSvc[svc]) {
                        return next(new errors.UpdateError(format(
                            'conflict: cannot make changes to a service and ' +
                            'an instance of that service: %s and %s',
                            reprFromChange(ch),
                            reprFromChange(changeFromSvc[svc]))));
                    }
                }
            }
            next();
        },

        /**
         * Drop service or inst updates that have no available update
         * candidates.
         */
        function dropNoops(_, next) {
            changes = changes.filter(function (ch) {
                if (ch.type === 'update-service' ||
                    ch.type === 'update-instance')
                {
                    if (ch.images.length === 0) {
                        // No available update candidates were found.
                        log.debug({change: ch},
                            'dropNoop: no update candidates');
                        return false;
                    }

                    // Exclude update to the same image as all current insts,
                    // unless --force-same-image.
                    if (!options.forceSameImage) {
                        var currImgUuids = {};
                        insts.forEach(function (inst) {
                            if (inst.service === ch.service.name) {
                                currImgUuids[inst.image] = true;
                            }
                        });
                        currImgUuids = Object.keys(currImgUuids);
                        if (currImgUuids.length === 0) {
                            // No insts -> use the image_uuid set on the
                            // service.
                            assert.ok(ch.service.params.image_uuid,
                                'service object has no "params.image_uuid": '
                                + JSON.stringify(ch.service));
                            currImgUuids.push(ch.service.params.image_uuid);
                        }
                        if (currImgUuids.length === 1) {
                            var sansCurr = ch.images.filter(function (img) {
                                return (img.uuid !== currImgUuids[0]);
                            });

                            if (sansCurr.length === 0) {
                                log.debug(
                                    {change: ch, currImgUuids: currImgUuids},
                                    'dropNoop: same image as all insts');
                                return false;
                            }
                        }
                    }
                }
                return true;
            });
            next();
        },

        /**
         * This is where we use inter-image dependencies to (a) resolve
         * candidate `images` for each change down to a single `image`, and
         * (b) add additional updates if required.
         *
         * We don't yet support deps (see: sdc-update project M9), so the
         * only step here is to select the latest candidate image.
         */
        function resolveDeps(_, next) {
            log.debug({changes: changes}, 'resolveDeps');
            for (var i = 0; i < changes.length; i++) {
                var ch = changes[i];
                if (!ch.image && ch.images.length) {
                    assert.arrayOfObject(ch.images,
                        'changes['+i+'].images');
                    // Assuming that `ch.images` is already sorted by
                    // `published_at`.
                    ch.images.sort(function (a, b) {
                        return common.cmp(a.published_at, b.published_at);
                    });
                    ch.image = ch.images[ch.images.length - 1];
                }
                delete ch.images;
            }
            next();
        },

        function disallowRabbitmqUpdates(_, next) {
            for (var i = 0; i < changes.length; i++) {
                var ch = changes[i];
                if (ch.service && ch.service.name === 'rabbitmq' &&
                    !options.forceRabbitmq)
                {
                        var changeRepr = JSON.stringify({
                             type: ch.type,
                             service: ch.service.name,
                             instance: ch.instance && ch.instance.instance
                        });
                        return next(new errors.UpdateError(format(
                            'rabbitmq updates are locked: %s ' +
                            '(use --force-rabbitmq flag)', changeRepr)));
                }
            }
            next();
        },

        // TODO: collect all violations and report them all at once
        // FIXME: if we have two errors, the second call to next()
        // will be done after we've finished the pipeline due to previous
        // error.
        function ensureVmMinPlatform(_, next) {
            var ch, server;
            for (var i = 0; i < changes.length; i++) {
                ch = changes[i];
                if (ch.service.type !== 'vm') {
                    continue;
                }
                if (ch.type === 'update-service') {
                    for (var j = 0; j < insts.length; j++) {
                        var inst = insts[j];
                        if (inst.service === ch.service.name) {
                            server = serverFromUuidOrHostname[inst.server];
                            if (server.current_platform <
                                self.config.vmMinPlatform)
                            {
                                return next(new errors.UpdateError(format(
                                    'insufficient platform for service "%s" ' +
                                    'instance "%s" on server "%s" (current ' +
                                    'platform is "%s", require minimum "%s")',
                                    inst.service, inst.instance, inst.server,
                                    server.current_platform,
                                    self.config.vmMinPlatform)));
                            }
                        }
                    }
                } else if (ch.type === 'update-instance') {
                    throw new Error('TODO');
                } else if (ch.type === 'create-instance') {
                    server = serverFromUuidOrHostname[ch.server];
                    throw new Error('TODO');
                }
            }
            next();
        },

        // TODO: collect all violations and report them all at once
        // FIXME: if we have two errors, the second call to next()
        // will be done after we've finished the pipeline due to previous
        // error.
        function minImageBuildDateFromSvcName(_, next) {
            var ch, server;
            for (var i = 0; i < changes.length; i++) {
                ch = changes[i];
                if (ch.service.type !== 'vm') {
                    continue;
                }
                if (ch.type === 'update-service') {
                    for (var j = 0; j < insts.length; j++) {
                        var inst = insts[j];
                        if (inst.service !== ch.service.name) {
                            continue;
                        }
                        if (!self.config.svcMinImages[inst.service]) {
                            continue;
                        }
                        var minImg = self.config.svcMinImages[inst.service];
                        var curImg = inst.version.split('-')[1];
                        if (minImg > curImg) {
                            return next(new errors.UpdateError(format(
                                'image for service "%s" is too old for ' +
                                'sdcadm update (min image is build date ' +
                                'is "%s" current image build date is "%s")',
                                inst.service,
                                minImg,
                                curImg
                            )));
                        }
                    }
                } else if (ch.type === 'update-instance') {
                    throw new Error('TODO');
                } else if (ch.type === 'create-instance') {
                    server = serverFromUuidOrHostname[ch.server];
                    console.log(server); // shut make check up about unused var
                    throw new Error('TODO');
                }

            }
            next();
        },

        function createPlan(_, next) {
            log.debug({changes: changes}, 'createPlan');
            var targ = common.deepObjCopy(insts);
            for (var i = 0; i < changes.length; i++) {
                var ch = changes[i];
                switch (ch.type) {
                case 'update-service':
                    for (var j = 0; j < targ.length; j++) {
                        var inst = targ[j];
                        if (inst.service === ch.service.name) {
                            inst.image = ch.image.uuid;
                            inst.version = ch.image.version;
                        }
                    }
                    break;
                // TODO: other change types
                default:
                    return next(new errors.InternalError({
                        message: 'unknown ch.type: ' + ch.type
                    }));
                }
            }
            plan = new UpdatePlan({
                curr: insts,
                targ: targ,
                changes: changes,
                justImages: justImages
            });
            next();
        },

        function determineProcedures(_, next) {
            procedures.coordinatePlan({
                plan: plan,
                sdcadm: self,
                serverFromUuidOrHostname: serverFromUuidOrHostname,
                log: log,
                progress: progress
            }, function (err, procs_) {
                plan.procs = procs_;
                next(err);
            });
        }

    ]}, function finishUp(err) {
        cb(err, plan);
    });
};


SdcAdm.prototype.summarizePlan = function summarizePlan(options) {
    assert.object(options, 'options');
    assert.object(options.plan, 'options.plan');
    assert.optionalFunc(options.progress, 'options.progress');

    var summary = options.plan.procs.map(
            function (proc) { return proc.summarize(); }).join('\n');
    options.progress(common.indent(summary));
};



/**
 * Execute an update plan.
 * The caller should be holding a `<SdcAdm>.acquireLock()`.
 *
 * @param options {Object}  Required.
 *      - plan {Object} Required. The update plan as returned by
 *        `genUpdatePlan`.
 *      - progress {Function} Optional. A function that is called
 *        with progress messages. Called like printf, i.e. passing in
 *        `console.log` or a Bunyan `log.info.bind(log)` is fine.
 *      - dryRun {Boolean} Optional. Default false.
 * @param cb {Function} Callback of the form `function (err)`.
 */
SdcAdm.prototype.execUpdatePlan = function execUpdatePlan(options, cb) {
    assert.object(options, 'options');
    assert.object(options.plan, 'options.plan');
    assert.optionalFunc(options.progress, 'options.progress');
    assert.optionalBool(options.dryRun, 'options.dryRun');
    assert.optionalString(options.uuid, 'options.uuid');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    var progress = options.progress || function () {};
    var plan = options.plan;

    var start = new Date();
    var wrkDir;
    var hist;

    vasync.pipeline({funcs: [
        function createWrkDir(_, next) {
            var stamp = sprintf('%d%02d%02dT%02d%02d%02dZ',
                start.getUTCFullYear(),
                start.getUTCMonth()+1,
                start.getUTCDate(),
                start.getUTCHours(),
                start.getUTCMinutes(),
                start.getUTCSeconds());
            wrkDir = '/var/sdcadm/updates/' + stamp;
            progress('Create work dir: ' + wrkDir);
            if (options.dryRun) {
                return next();
            }
            mkdirp(wrkDir, function (err) {
                if (err) {
                    next(new errors.InternalError({
                        message: 'error creating work dir: ' + wrkDir,
                        cause: err
                    }));
                    return;
                }
                next();
            });
        },

        function savePlan(_, next) {
            if (options.dryRun) {
                return next();
            }
            var planFile = path.resolve(wrkDir, 'plan.json');
            fs.writeFile(planFile,
                plan.serialize(),
                'utf8',
                function (err) {
                    if (err) {
                        return next(new errors.InternalError({
                            cause: err,
                            message: 'error saving update plan: ' + planFile
                        }));
                    }
                    next();
                });
        },

        function saveBeginningToHistory(_, next) {
            var obj = {
                changes: plan.changes
            };

            if (options.uuid) {
                obj.uuid = options.uuid;
            }

            self.history.saveHistory(obj, function (err, hst) {
                if (err) {
                    return next(err);
                }
                hist = hst;
                return next();
            });
        },

        function execProcedures(_, next) {
            if (options.dryRun) {
                return next();
            }
            vasync.forEachPipeline({
                inputs: plan.procs,
                func: function execProc(proc, nextProc) {
                    log.debug({summary: proc.summarize()}, 'execProc');
                    proc.execute({
                        sdcadm: self,
                        plan: plan,
                        progress: progress,
                        log: log,
                        wrkDir: wrkDir
                    }, nextProc);
                }
            }, next);
        }

    ]}, function (err) {
        // Add error to history in case the update execution failed:
        if (err) {
            hist.error = err;
        }
        // No need to add `history.finished` here, History instance will handle
        self.history.updateHistory(hist, function (err2, hist2) {
            if (err) {
                cb(err);
            } else if (err2) {
                cb(err2);
            } else {
                cb();
            }
        });
    });
};


/**
 * Update to the latest available sdcadm package.
 *
 * TODO:
 * - support passing in a package UUID to which to update
 *
 * @param options {Object}  Required.
 *      - allowMajorUpdate {Boolean} Optional. Default false. By default
 *        self-update will only consider versions of the same major version.
 *      - dryRun {Boolean} Optional. Default false. Go through the motions
 *        without actually updating.
 *      - progress {Function} Optional. A function that is called
 *        with progress messages. Called as `progress(<string>)`. E.g. passing
 *        console.log is legal.
 * @param cb {Function} Callback of the form `function (err)`.
 */
SdcAdm.prototype.selfUpdate = function selfUpdate(options, cb) {
    assert.object(options, 'options');
    assert.optionalBool(options.allowMajorUpdate, 'options.allowMajorUpdate');
    assert.optionalBool(options.dryRun, 'options.dryRun');
    assert.optionalFunc(options.progress, 'options.progress');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    var progress = options.progress || function () {};

    var unlock;
    var dryRunPrefix = (options.dryRun ? '[dry-run] ' : '');
    var currVer = pkg.version;
    var currBuildtime;
    var updateManifest;
    var installerPath;
    var start;
    var wrkDir;
    var hist;
    var changes = [
    {
        type: 'service',
        service: {
            type: 'service',
            name: 'sdcadm',
            version: currVer
        }
    }];
    vasync.pipeline({funcs: [
        function getLock(_, next) {
            if (options.dryRun) {
                return next();
            }
            self.acquireLock({progress: progress}, function (lockErr, unlock_) {
                unlock = unlock_;
                next(lockErr);
            });
        },
        function setStart(_, next) {
            // Set start time after getting lock to avoid collisions in wrkDir.
            start = new Date();
            next();
        },

        function getCurrBuildtime(_, next) {
            // SDC buildstamps are '$branch-$buildtime-g$sha'. The '$branch'
            // can have hyphens in it.
            var buildstampPath = path.resolve(__dirname, '..', 'etc',
                'buildstamp');
            fs.readFile(buildstampPath, 'utf8', function (err, data) {
                if (err) {
                    next(new errors.InternalError({
                        message: 'error getting current buildstamp',
                        path: buildstampPath,
                        cause: err
                    }));
                    return;
                }
                var parts = data.trim().split(/-/g);
                currBuildtime = parts[parts.length - 2];
                changes[0].service.build = data.trim();
                next();
            });
        },

        function findLatestSdcAdm(_, next) {
            var filters = {
                name: 'sdcadm'
            };
            self.updates.listImages(filters, function (err, candidates) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'updates'));
                }

                // Filter out versions before the current.
                candidates = candidates.filter(function dropLowerVer(c) {
                    if (semver.lt(c.version, currVer)) {
                        //log.trace({candidate: c, currVer: currVer},
                        //    'drop sdcadm candidate (lower ver)');
                        return false;
                    }
                    return true;
                });

                // Unless `allowMajorUpdate`, filter out major updates (and
                // warn).
                if (!options.allowMajorUpdate) {
                    var currMajor = currVer.split(/\./)[0] + '.x';
                    var droppedVers = [];
                    candidates = candidates.filter(function dropMajor(c) {
                        var drop = !semver.satisfies(c.version, currMajor);
                        if (drop) {
                            droppedVers.push(c.version);
                            log.trace({candidate: c, currMajor: currMajor},
                                'drop sdcadm candidate (major update)');
                        }
                        return !drop;
                    });
                    if (droppedVers.length) {
                        droppedVers.sort(semver.compare);
                        progress('Skipping available major sdcadm '
                            + 'update, version %s (use --allow-major-update '
                            + 'to allow)',
                            droppedVers[droppedVers.length - 1]);
                    }
                }

                // Filter out buildstamps <= the current (to exclude
                // earlier builds at the same `version`).
                candidates = candidates.filter(function dropLowerStamp(c) {
                    var buildtime = c.tags.buildstamp.split(/-/g)
                            .slice(-2, -1)[0];
                    if (buildtime <= currBuildtime) {
                        log.trace({candidate: c, buildtime: buildtime},
                            'drop sdcadm candidate (<= buildtime)');
                        return false;
                    }
                    return true;
                });

                // Sort by (version, publish date) and select the latest
                if (candidates.length) {
                    candidates.sort(function (a, b) {
                        var ver = semver.compare(a.version, b.version);
                        if (ver) {
                            return ver;
                        } else if (a.tags.buildstamp > b.tags.buildstamp) {
                            return 1;
                        } else if (a.tags.buildstamp < b.tags.buildstamp) {
                            return -1;
                        } else {
                            return 0;
                        }
                    });
                    updateManifest = candidates[candidates.length - 1];
                    changes[0].image = updateManifest;
                    progress('%sUpdate to sdcadm %s (%s)', dryRunPrefix,
                        updateManifest.version,
                        updateManifest.tags.buildstamp);
                } else {
                    progress('No available sdcadm updates in %s',
                        self.config.updatesServerUrl);
                }
                next();
            });
        },

        function saveChangesToHistory(_, next) {
            if (!updateManifest) {
                return next();
            }

            self.history.saveHistory({
                changes: changes
            }, function (err, hst) {
                if (err) {
                    return next(err);
                }
                hist = hst;
                return next();
            });
        },

        function downloadInstaller(_, next) {
            if (!updateManifest) {
                return next();
            }

            progress('%sDownload update from %s', dryRunPrefix,
                self.config.updatesServerUrl);
            if (options.dryRun) {
                return next();
            }
            // TODO progress bar on this
            installerPath = '/var/tmp/sdcadm-' + updateManifest.uuid;
            self.updates.getImageFile(updateManifest.uuid, installerPath,
                    function (downloadErr) {
                if (downloadErr) {
                    next(new errors.InternalError({
                        message: 'error downloading sdcadm package',
                        updatesServerUrl: self.config.updatesServerUrl,
                        uuid: updateManifest.uuid,
                        cause: downloadErr
                    }));
                    return;
                }
                fs.chmod(installerPath, 0755, function (chmodErr) {
                    if (chmodErr) {
                        next(new errors.InternalError({
                            message: 'error chmoding sdcadm installer',
                            path: installerPath,
                            cause: chmodErr
                        }));
                        return;
                    }
                    next();
                });
            });
        },

        function createWrkDir(_, next) {
            if (!updateManifest) {
                return next();
            }
            var stamp = sprintf('%d%02d%02dT%02d%02d%02dZ',
                start.getUTCFullYear(),
                start.getUTCMonth()+1,
                start.getUTCDate(),
                start.getUTCHours(),
                start.getUTCMinutes(),
                start.getUTCSeconds());
            wrkDir = '/var/sdcadm/self-updates/' + stamp;
            mkdirp(wrkDir, function (err) {
                if (err) {
                    next(new errors.InternalError({
                        message: 'error creating work dir: ' + wrkDir,
                        cause: err
                    }));
                    return;
                }
                next();
            });
        },

        function runInstaller(_, next) {
            if (!updateManifest) {
                return next();
            }
            progress('%sRun sdcadm installer (log at %s/install.log)',
                dryRunPrefix, wrkDir);
            if (options.dryRun) {
                return next();
            }
            var cmd = format('%s >%s/install.log 2>&1', installerPath,
                wrkDir);
            var env = common.objCopy(process.env);
            env.TRACE = '1';
            env.SDCADM_LOGDIR = wrkDir; // bwcompat for sdcadm <1.2.0 installers
            env.SDCADM_WRKDIR = wrkDir;
            var execOpts = {env: env};
            log.trace({cmd: cmd}, 'run sdcadm installer');
            exec(cmd, execOpts, function (err, stdout, stderr) {
                log.trace({cmd: cmd, err: err, stdout: stdout, stderr: stderr},
                    'ran sdcadm installer');
                if (err) {
                    // TODO: The installer *does* typically restore the old one
                    // on failure. There is a swap (two `mv`s) during which a
                    // crash will leave in inconsistent state. We could check
                    // for that here and cleanup, or just warn about the
                    // situation.
                    return next(new errors.InternalError({
                        message: 'error running sdcadm installer',
                        cmd: cmd,
                        stdout: stdout,
                        stderr: stderr,
                        cause: err
                    }));
                }
                next();
            });
        }

    ]}, function finishUp(err) {
        vasync.pipeline({funcs: [
            function dropLock(_, next) {
                if (options.dryRun) {
                    return next();
                }
                self.releaseLock({unlock: unlock}, next);
            },
            function updateHist(_, next) {
                if (!updateManifest) {
                    return next();
                }
                // Add error to history in case the update execution failed:
                if (err) {
                    hist.error = err;
                }
                // No need to add `history.finished` here:
                self.history.updateHistory(hist, function (err2, hist2) {
                    if (err2) {
                        next(err2);
                    } else {
                        next();
                    }
                });
            },
            function noteCompletion(_, next) {
                if (!updateManifest || err) {
                    return next();
                }
                progress('%sUpdated to sdcadm %s (%s, elapsed %ss)',
                    dryRunPrefix, updateManifest.version,
                    updateManifest.tags.buildstamp,
                    Math.floor((Date.now() - start) / 1000));
                next();
            }
        ]}, function done(finishUpErr) {
            // We shouldn't ever get a `finishUpErr`. Let's be loud if we do.
            if (finishUpErr) {
                log.fatal({err: finishUpErr},
                    'unexpected error finishing up self-update');
            }
            cb(err || finishUpErr);
        });
    });
};


SdcAdm.prototype._dcMaintInfoPath = '/var/sdcadm/dc-maint.json';

/**
 * Maintenance mode current status.
 *
 * @param cb {Function} Callback of the form `function (err, status)`.
 *      where `status` is an object like the following:
 *          {maint: false}         // not in maint mode
 *          {maint: true}          // in maint mode, don't have start time
 *          {maint: true, startTime: <date>}
 */
SdcAdm.prototype.dcMaintStatus = function dcMaintStatus(cb) {
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;

    var sdcApp;
    var cloudapiSvc;
    var maint;
    var startTime;

    vasync.pipeline({funcs: [
        function getSdcApp(_, next) {
            self.sapi.listApplications({name: 'sdc'}, function (appErr, apps) {
                if (appErr) {
                    return next(new errors.SDCClientError(appErr, 'sapi'));
                } else if (!apps || apps.length !== 1) {
                    return next(new errors.InternalError({
                        message: format(
                            'unexpected number of "sdc" SAPI apps: %j', apps)
                    }));
                }
                sdcApp = apps[0];
                next();
            });
        },
        function getCloudapiSvc(_, next) {
            var filters = {
                application_uuid: sdcApp.uuid,
                name: 'cloudapi'
            };
            self.sapi.listServices(filters, function (svcsErr, svcs) {
                if (svcsErr) {
                    return next(new errors.SDCClientError(svcsErr, 'sapi'));
                } else if (!svcs || svcs.length !== 1) {
                    return next(new errors.InternalError({
                        message: format('unexpected number of "cloudapi" ' +
                            'SAPI svcs: %j', svcs)
                    }));
                }
                cloudapiSvc = svcs[0];
                next();
            });
        },

        function checkIfInMaint(_, next) {
            maint = cloudapiSvc.metadata.CLOUDAPI_READONLY;
            log.debug({maint: maint}, 'maint mode from CLOUDAPI_READONLY');
            next();
        },

        /**
         * Showing the start time is strictly a convenience.
         */
        function loadStartTime(_, next) {
            if (!maint) {
                return next();
            }
            fs.readFile(self._dcMaintInfoPath, 'utf8', function (err, content) {
                if (err) {
                    // This is a convenience step. Just note this.
                    log.warn({dcMaintInfoPath: self._dcMaintInfoPath, err: err},
                        'could not loading dc-maint info file');
                } else {
                    try {
                        startTime = JSON.parse(content).startTime;
                    } catch (parseErr) {
                        log.warn(parseErr,
                            'could not parse dc-maint info file');
                    }
                }
                next();
            });
        }

    ]}, function (err) {
        if (err) {
            cb(err);
        } else {
            var status = {maint: maint};
            if (startTime) {
                status.startTime = startTime;
            }
            cb(null, status);
        }
    });
};


/**
 * Enter maintenance mode.
 *
 * @param opts {Object}  Required.
 *      - progress {Function} Optional. A function that is called
 *        with progress messages. Called like printf, i.e. passing in
 *        `console.log` or a Bunyan `log.info.bind(log)` is fine.
 * @param cb {Function} Callback of the form `function (err)`.
 */
SdcAdm.prototype.dcMaintStart = function dcMaintStart(opts, cb) {
    assert.object(opts, 'opts');
    assert.optionalFunc(opts.progress, 'opts.progress');
    assert.func(cb, 'cb');
    var self = this;
    var progress = opts.progress || function () {};

    var sdcApp;
    var cloudapiSvc;
    var doIt = false;
    var startTime;

    vasync.pipeline({funcs: [
        function getSdcApp(_, next) {
            self.sapi.listApplications({name: 'sdc'}, function (appErr, apps) {
                if (appErr) {
                    return next(new errors.SDCClientError(appErr, 'sapi'));
                } else if (!apps || apps.length !== 1) {
                    return next(new errors.InternalError({
                        message: format(
                            'unexpected number of "sdc" SAPI apps: %j', apps)
                    }));
                }
                sdcApp = apps[0];
                next();
            });
        },
        function getCloudapiSvc(_, next) {
            var filters = {
                application_uuid: sdcApp.uuid,
                name: 'cloudapi'
            };
            self.sapi.listServices(filters, function (svcsErr, svcs) {
                if (svcsErr) {
                    return next(new errors.SDCClientError(svcsErr, 'sapi'));
                } else if (!svcs || svcs.length !== 1) {
                    return next(new errors.InternalError({
                        message: format('unexpected number of "cloudapi" ' +
                            'SAPI svcs: %j', svcs)
                    }));
                }
                cloudapiSvc = svcs[0];
                next();
            });
        },
        function checkIfInMaint(_, next) {
            if (cloudapiSvc.metadata.CLOUDAPI_READONLY === true) {
                progress('Already in DC maintenance');
            } else {
                doIt = true;
            }
            next();
        },

        function setCloudapiReadonly(_, next) {
            if (!doIt) {
                return next();
            }
            progress('Putting cloudapi in read-only mode');
            startTime = new Date();
            self.sapi.updateService(
                cloudapiSvc.uuid,
                {metadata: {CLOUDAPI_READONLY: true}},
                function (err, svc) {
                    if (err) {
                        return next(new errors.SDCClientError(err, 'sapi'));
                    }
                    next();
                });
        },

        /**
         * Note: We aren't waiting for config-agent in the cloudapi instance(s)
         * to effect this change. TODO: add readonly status to /--ping on
         * cloudapi and watch for that.
         */

        function saveStartTime(_, next) {
            if (!doIt) {
                return next();
            }
            var info = JSON.stringify({
                'startTime': startTime
            }, null, 4);
            fs.writeFile(self._dcMaintInfoPath, info, 'utf8', next);
        },

        function waitForWorkflowDrain(_, next) {
            progress('Waiting up to 5 minutes for workflow jobs to drain');
            var remaining = 60;
            var MAX_ERRS = 3;
            var numErrs = 0;
            setTimeout(pollJobs, 5000);

            function pollJobs() {
                remaining--;
                if (remaining <= 0) {
                    return next(new errors.InternalError({
                        message: 'timeout waiting for workflow jobs to drain'
                    }));
                }
                self.wfapi.listJobs({execution: 'running', limit: 10},
                        function (rErr, rJobs) {
                    if (rErr) {
                        numErrs++;
                        self.log.error(rErr, 'error listing running jobs');
                        if (numErrs >= MAX_ERRS) {
                            return next(rErr);
                        }
                    } else if (rJobs.length > 0) {
                        self.log.debug({numJobs: rJobs.length}, 'running jobs');
                        return setTimeout(pollJobs, 5000);
                    }
                    self.wfapi.listJobs({execution: 'queued', limit: 10},
                            function (qErr, qJobs) {
                        if (qErr) {
                            numErrs++;
                            self.log.error(qErr, 'error listing queued jobs');
                            if (numErrs >= MAX_ERRS) {
                                return next(qErr);
                            }
                        } else if (qJobs.length > 0) {
                            self.log.debug({numJobs: qJobs.length},
                                'queued jobs');
                            return setTimeout(pollJobs, 5000);
                        }
                        progress('Workflow cleared of running and queued jobs');
                        next();
                    });
                });
            }
        }
    ]}, cb);
};


/**
 * Leave maintenance mode.
 *
 * @param opts {Object}  Required.
 *      - progress {Function} Optional. A function that is called
 *        with progress messages. Called like printf, i.e. passing in
 *        `console.log` or a Bunyan `log.info.bind(log)` is fine.
 * @param cb {Function} Callback of the form `function (err)`.
 */
SdcAdm.prototype.dcMaintStop = function dcMaintStop(opts, cb) {
    assert.object(opts, 'opts');
    assert.optionalFunc(opts.progress, 'opts.progress');
    assert.func(cb, 'cb');
    var self = this;
    var log = self.log;
    var progress = opts.progress || function () {};

    var sdcApp;
    var cloudapiSvc;
    var doIt = false;

    vasync.pipeline({funcs: [
        function getSdcApp(_, next) {
            self.sapi.listApplications({name: 'sdc'}, function (appErr, apps) {
                if (appErr) {
                    return next(new errors.SDCClientError(appErr, 'sapi'));
                } else if (!apps || apps.length !== 1) {
                    return next(new errors.InternalError({
                        message: format(
                            'unexpected number of "sdc" SAPI apps: %j', apps)
                    }));
                }
                sdcApp = apps[0];
                next();
            });
        },
        function getCloudapiSvc(_, next) {
            var filters = {
                application_uuid: sdcApp.uuid,
                name: 'cloudapi'
            };
            self.sapi.listServices(filters, function (svcsErr, svcs) {
                if (svcsErr) {
                    return next(new errors.SDCClientError(svcsErr, 'sapi'));
                } else if (!svcs || svcs.length !== 1) {
                    return next(new errors.InternalError({
                        message: format('unexpected number of "cloudapi" ' +
                            'SAPI svcs: %j', svcs)
                    }));
                }
                cloudapiSvc = svcs[0];
                next();
            });
        },
        function checkIfInMaint(_, next) {
            if (cloudapiSvc.metadata.CLOUDAPI_READONLY !== true) {
                progress('Not in DC maintenance');
            } else {
                doIt = true;
            }
            next();
        },

        function setCloudapiWriteable(_, next) {
            if (!doIt) {
                return next();
            }
            progress('Taking cloudapi out of read-only mode');
            self.sapi.updateService(
                cloudapiSvc.uuid,
                {metadata: {CLOUDAPI_READONLY: false}},
                function (err, svc) {
                    if (err) {
                        return next(new errors.SDCClientError(err, 'sapi'));
                    }
                    next();
                });
        },

        /**
         * Note: We aren't waiting for config-agent in the cloudapi instance(s)
         * to effect this change. TODO: add readonly status to /--ping on
         * cloudapi and watch for that. ... on all instances?
         */

        function rmInfoFile(_, next) {
            if (!doIt) {
                return next();
            }
            fs.unlink(self._dcMaintInfoPath, function (err) {
                if (err) {
                    // The info file is sugar. Don't fail if it isn't there.
                    log.warn({dcMaintInfoPath: self._dcMaintInfoPath, err: err},
                        'could not remove dc-maint info file');
                }
                next();
            });
        }

    ]}, cb);
};

/**
 * Check SAPI config against system "reality" and print out inconsistencies
 *
 * @param cb {Function} Callback of the form `function (err, result)`.
 */

SdcAdm.prototype.checkConfig = function (opts, cb) {
    var self = this;
    // SAPI values for sdc application:
    var sdc;
    // Name of SAPI services for VMs:
    var services;
    // Headnode sysinfo:
    var sysinfo;
    // External and admin networks:
    var admin;
    var external;

    // Errors:
    var errs = [];

    function getSysinfo(_, next) {
        self.cnapi.listServers({
            headnode: true,
            extras: 'sysinfo'
        }, function (err, res) {
            if (err) {
                return next(err);
            }
            sysinfo = (res && res.length > 0 ? res[0].sysinfo : null);

            Object.keys(sysinfo['Network Interfaces']).filter(function (k) {
                return (sysinfo['Network Interfaces'][k]['NIC Names'][0] ===
                    'admin');
            }).map(function (k) {
                if (sysinfo['Network Interfaces'][k]['MAC Address'] !==
                    sdc.admin_nic) {
                    errs.push('SAPI sdc admin_nic did not match with GZ ' +
                        'Admin MAC Address');
                }
                if (sysinfo['Network Interfaces'][k].ip4addr !== sdc.admin_ip) {
                    errs.push('SAPI sdc admin_ip did not match with GZ ' +
                        'Admin IPv4 Address');
                }
            });

            Object.keys(sysinfo['Virtual Network Interfaces']).
                filter(function (k) {
                return (k === 'external0');
            }).map(function (k) {
                if (sysinfo['Virtual Network Interfaces'][k].ip4addr !==
                    sdc.external_ip) {
                    errs.push('SAPI sdc external_ip did not match with GZ ' +
                        'External IPv4 Address');
                }
            });

            return next();
        });
    }


    function getNetworks(_, next) {
        self.napi.listNetworks({name: 'admin'}, function (err, res) {
            if (err) {
                return next(err);
            }
            admin = (res && res.length > 0 ? res[0] : null);
            if (admin.subnet.split('/')[0] !== sdc.admin_network) {
                errs.push('SAPI sdc admin_network did not match with value '+
                    'defined in NAPI');
            }
            if (admin.netmask !== sdc.admin_netmask) {
                errs.push('SAPI sdc admin_netmask did not match with value '+
                    'defined in NAPI');
            }
            // PEDRO: Note we should stop assuming external network will always
            // exist and, therefore, shouldn't return error on the next NAPI
            // call:
            self.napi.listNetworks({name: 'external'}, function (err2, res2) {
                if (err2) {
                    return next(err2);
                }
                external = (res2 && res2.length > 0 ? res2[0] : null);
                if (external.subnet &&
                    external.subnet.split('/')[0] !== sdc.external_network) {
                    errs.push('SAPI sdc external_network did not match with '+
                        'value defined in NAPI');
                }
                if (external.netmask !== sdc.external_netmask) {
                    errs.push('SAPI sdc external_netmask did not match with '+
                        'value defined in NAPI');
                }
                if (external.gateway !== sdc.external_gateway) {
                    errs.push('SAPI sdc external_gateway did not match with '+
                        'value defined in NAPI');
                }
                if (external.provision_start_ip !==
                    sdc.external_provisionable_start) {
                    errs.push('SAPI sdc external_provisionable_start did not '+
                        'match with value defined in NAPI');
                }
                if (external.provision_end_ip !==
                        sdc.external_provisionable_end) {
                    errs.push('SAPI sdc external_provisionable_end did not '+
                        'match with value defined in NAPI');
                }
                return next();
            });
        });
    }

    function getDcFromUfds(_, next) {
        self.ufds.search('o=smartdc', {
            scope: 'sub',
            filter: sprintf('(&(objectclass=datacenter)(datacenter=%s))',
                self.config.datacenter_name)
        }, function (err, res) {
            if (err) {
                return next(err);
            }
            if (!res) {
                errs.push('No DC information found in UFDS');
                return next();
            }
            res.forEach(function (r) {
                if (r.region !== sdc.region_name) {
                    errs.push(sprintf(
                        'region did not match with region_name for entry ' +
                        'with DN: %s', r.dn));
                }
                if (r.datacenter !== sdc.datacenter_name) {
                    errs.push(sprintf(
                        'datacenter did not match with datacenter_name for ' +
                        'entry with DN: %s', r.dn));
                }
                // company_name and location are not required for anything to
                // work properly, therefore, skipping them here
            });
            return next();
        });
    }

    function getUfdsAdmin(_, next) {
        self.ufds.search('o=smartdc', {
            scope: 'sub',
            filter: sprintf('(&(objectclass=sdcperson)(uuid=%s))',
                self.config.ufds_admin_uuid)
        }, function (err, res) {
            if (err) {
                return next(err);
            }

            var ufdsAdmin = (res && res.length > 0 ? res[0] : null);

            if (!ufdsAdmin) {
                errs.push('Cannot find UFDS admin user');
            }

            if (ufdsAdmin.login !== sdc.ufds_admin_login) {
                errs.push('UFDS admin login did not match SAPI ' +
                    'ufds_admin_login');
            }

            if (ufdsAdmin.email !== sdc.ufds_admin_email) {
                errs.push('UFDS admin email did not match SAPI ' +
                    'ufds_admin_email');
            }

            self.ufds.search(sprintf('uuid=%s, ou=users, o=smartdc',
                        self.config.ufds_admin_uuid), {
                scope: 'sub',
                filter: sprintf('(objectclass=sdckey)',
                    self.config.ufds_admin_key_fp)
            }, function (err2, res2) {
                if (err2) {
                    return next(err2);
                }

                if (!res2.length) {
                    errs.push('Cannot find UFDS admin key');
                    return next();
                }

                var sdcKey = res2.filter(function (k) {
                    return (k.fingerprint === sdc.ufds_admin_key_fingerprint);
                })[0];

                if (!sdcKey) {
                    errs.push('Cannot find UFDS admin key');
                    return next();
                }

                if (sdcKey.openssh !== sdc.ufds_admin_key_openssh.trim()) {
                    errs.push('UFDS Admin key did not match with SAPI '+
                            'ufds_admin_key_openssh');
                }
                return next();
            });
        });
    }

    // PEDRO: Shall we really care about core zone Admin IP addresses here?:
    // (Ignoring for now)
    function getVmsIps(_, next) {
        var filters = {
            query: sprintf('(&(tags=*-smartdc_type=core-*)' +
                   '(|(state=running)(state=provisioning)(state=stopped))' +
                   '(owner_uuid=%s))', self.config.ufds_admin_uuid)
        };
        self.vmapi.listVms(filters, function (vmsErr, _vms) {
            if (vmsErr) {
                return next(vmsErr);
            }
            return next();
        });

    }

    self.sapi.listApplications({name: 'sdc'}, function (err, res) {
        if (err) {
            return cb(err);
        }
        sdc = (res && res.length > 0 ? res[0].metadata : null);
        if (!sdc) {
            return cb('Cannot find SDC application in SAPI');
        }
        self.sapi.listServices({
            application_uuid: res[0].uuid
        }, function (err2, res2) {
            if (err2) {
                return cb(err2);
            }
            if (!res2.length) {
                return cb('Cannot find SDC services in SAPI');
            }

            services = res2.filter(function (s) {
                return (s.type === 'vm');
            }).map(function (s) {
                return (s.name);
            });

            vasync.pipeline({
                funcs: [
                    getSysinfo,
                    getNetworks,
                    getDcFromUfds,
                    getUfdsAdmin,
                    getVmsIps
                ]
            }, function (err4, _res) {
                if (err4) {
                    return cb(err4);
                }

                // PEDRO: Note the exceptions listed below. I bet we could
                // remove most of these variables anyway, and left a single
                // value for *_pw.
                services.forEach(function (s) {
                    if (!sdc[s + '_root_pw'] && s !== 'manta' && s !== 'sapi') {
                        errs.push(sprintf('Missing %s_root_pw in SAPI', s));
                    }

                    if (!sdc[s + '_admin_ips'] && s !== 'cloudapi' &&
                        s !== 'manta' && s !== 'sdcsso') {
                        errs.push(sprintf('Missing %s_admin_ips in SAPI', s));
                    }

                    if (s !== 'manatee' && s !== 'binder' &&
                        s !== 'manta' && s !== 'cloudapi') {
                        if (!sdc[s + '_domain']) {
                            errs.push(sprintf('Missing %s_domain in SAPI', s));
                        }
                        if (!sdc[s.toUpperCase() + '_SERVICE']) {
                            errs.push(sprintf('Missing %s_SERVICE in SAPI',
                                    s.toUpperCase()));
                        }
                    }
                });
                // Check that ufds_remote_ip is present if this is not master:
                if (!sdc.ufds_is_master || sdc.ufds_is_master === 'false') {
                    if (!sdc.ufds_remote_ip) {
                        errs.push('Missing SAPI variable "ufds_remote_ip"');
                    }
                }
                return self.ufds.close(function (err3) {
                    return cb(null, errs);
                });
            });
        });
    });
};


/**
 * Check health of given SAPI instances.
 *
 * @param opts {Object}  Required.
 *      - uuids {Array} Optional. SAPI instance (or service) UUIDs to check.
 *        If not given, then all SDC instances are checked.
 * @param cb {Function} Callback of the form `function (err, results)`.
 */
SdcAdm.prototype.checkHealth = function checkHealth(opts, cb) {
    var self = this;
    assert.object(opts, 'opts');
    assert.optionalArrayOfString(opts.uuids, 'opts.uuids');
    assert.func(cb, 'cb');

    var svcLookup = {};
    var uuidLookup;
    var insts;

    if (opts.uuids) {
        uuidLookup = {};
        opts.uuids.forEach(function (id) { uuidLookup[id] = true; });
    }

    function connectToUr(_, next) {
        self.ur.once('ready', next);
    }

    function lookupServices(_, next) {
        self.getServices({}, function (err, svcs) {
            if (err) {
                next(err);
            }

            self.log.debug({ services: svcs }, 'Look up services');

            if (uuidLookup) {
                svcs = svcs.filter(function (svc) {
                    var found = uuidLookup[svc.uuid];

                    if (found) {
                        delete uuidLookup[svc.uuid];
                    }

                    return found;
                });
            }

            svcs.forEach(function (svc) {
                if (svc.type === 'vm' || svc.type === 'agent') {
                    svcLookup[svc.name] = true;
                }
            });

            return next();
        });
    }

    function lookupInstances(_, next) {
        self.getInstances({}, function (err, insts_) {
            if (err) {
                return next(err);
            }

            self.log.debug({ instances: insts_ }, 'Look up instances');

            insts = insts_.filter(function (inst) {
                if (inst.type !== 'vm' && inst.type !== 'agent') {
                    return false;
                }

                if (!svcLookup[inst.service] &&
                    !(uuidLookup && uuidLookup[inst.instance])) {
                    return false;
                }

                if (uuidLookup) {
                    delete uuidLookup[inst.instance];
                }

                if (inst.type === 'vm' && !inst.ip) {
                    self.log.error(inst.instance, 'VM has no admin IP, skip!');
                    return false;
                }

                return true;
            });

            if (uuidLookup && Object.keys(uuidLookup).length > 0) {
                var msg = 'unrecognized service or instances: ' +
                    Object.keys(uuidLookup).join(', ');
                return next(new Error(msg));
            }

            return next();
        });
    }

    function checkInst(inst, next) {
        var script;

        if (inst.type === 'vm') {
            script = 'svcs -vxz ' + inst.instance;
        } else if (inst.type === 'agent') {
            script = 'svcs -vx ' + inst.service;
        } else {
            return next();
        }

        // there are a couple agent instances which don't actually have
        // services, so skip them
        if (inst.instance.match(/(agents_core|cabase)$/)) {
            return next();
        }

        self.ur.exec({
            script: script,
            server_uuid: inst.server,
            timeout: 5000
        }, function (err, result) {
            if (err) {
                return next(err);
            }

            self.log.debug({ ur_response: result },
                           'Ur result for ' + inst.instance);

            if (result.exit_status !== 0 ||
                result.stderr !== '' ||
                !(result.stdout === '' ||
                  result.stdout.match(/State\: online/))) {

                inst.healthy = false;

                var errs = [];

                if (result.exit_status !== 0) {
                    errs.push('svcs returned ' + result.exit_status);
                }

                if (result.stderr) {
                    errs.push('stderr: ' + result.stderr.replace(/\n+$/, ''));
                }

                if (!(result.stdout === '' ||
                      result.stdout.match(/State\: online/))) {
                    errs.push('stdout: ' + result.stdout.replace(/\n+$/, ''));
                }

                if (errs.length > 0) {
                    inst.health_errors = errs.map(function (error) {
                        return { message: 'SMF svcs check failed: ' + error };
                    });
                }

                return next(null, inst);
            }

            var pingPath = PING_PATHS[inst.service];

            if (!pingPath) {
                inst.healthy = true;
                return next(null, inst);
            }

            var port = PING_PORTS[inst.service] || 80;

            var httpClient = (port === 443 ? https : http);

            httpClient.get({
                hostname: inst.ip,
                port: port,
                path: pingPath,
                agent: false,
                rejectUnauthorized: false
            }, function (res) {
                self.log.debug({ http_response: res.statusCode },
                               'HTTP result for ' + inst.instance);

                inst.healthy = (res.statusCode === 200);

                if (!inst.healthy) {
                    inst.health_errors = [ {
                        message: 'ping check to ' + inst.ip + ' failed with ' +
                                 'HTTP code ' + res.statusCode
                    } ];
                }

                return next(null, inst);
            }).once('error', function (e) {
                inst.healthy = false;

                inst.health_errors = [ {
                    message: 'ping check to ' + inst.ip + ' failed: ' +
                             e.message
                } ];

                return next(null, inst);
            });
        });
    }

    vasync.pipeline({ funcs: [
        connectToUr, lookupServices, lookupInstances
    ]}, function (err) {
        if (err) {
            return cb(err);
        }

        vasync.forEachParallel({
            inputs: insts,
            func: checkInst
        }, function (err2, results) {
            self.ur.close();

            // TODO: this is a very savage way of cleaning up after urclient.
            // Something inside it doesn't want to let go.
            process._getActiveHandles().forEach(function (h) {
                if (h.destroy) {
                    h.destroy();
                }
            });

            if (err2) {
                return cb(err2);
            }

            var healthResults = results.successes.filter(function (res) {
                return res;
            });

            return cb(null, healthResults);
        });
    });
};

SdcAdm.prototype.createCloudapiInstance =
function createCloudapiInstance(opts, callback) {
    var self = this;
    var sapi = self.sapi;
    assert.func(opts.progress, 'opts.progress');

    var networks;
    var progress = opts.progress;
    var cloudapisvc;

    // find cloudapi service, get service uuid
    // use sapi.createInstance to create the service

    vasync.pipeline({ funcs: [
        function (_, next) {
            sapi.listServices({ name: 'cloudapi' }, function (err, svcs) {
                if (err) {
                    return next(err);
                }
                if (svcs.length !== 1) {
                    return next(new Error(
                        'expected 1 cloudapi service, found %d', svcs.length));
                }
                cloudapisvc = svcs[0];
                next();
            });
        },
        function (_, next) {
            getNetworksAdminExternal({}, function (err, nets) {
                if (err) {
                    return next(err);
                }
                networks = nets;
                next();
            });
        },
        function (_, next) {
            var createOpts = {
                params: {
                    alias: opts.alias,
                    owner_uuid: self.config.ufds_admin_uuid,
                    networks: [
                        {
                            uuid: networks.admin.uuid
                        },
                        {
                            primary: true,
                            uuid: networks.external.uuid
                        }
                    ]
                }
            };
            sapi.createInstance(cloudapisvc.uuid, createOpts, function (err) {
                if (err) {
                    return next(err);
                }
                next();
            });
        }
    ] }, function (err) {
        progress('cloudapi0 zone created');
        callback();
    });

    function getNetworksAdminExternal(err, cb) {
        var napi = self.napi;
        var foundnets = {};

        napi.listNetworks({ name: ['admin', 'external'] },
        function (listerr, nets) {
            if (listerr) {
                return cb(err);
            }

            if (!nets.length) {
                return cb(new Error('Couldn\'t find admin network in NAPI'));
            }
            for (var i in nets) {
                foundnets[nets[i].name] = nets[i];
            }

            cb(null, foundnets);
        });
    }
};


SdcAdm.prototype.setupCommonExternalNics = function
setupCommonExternalNics(opts, cb) {
    var self = this;
    var sapi = self.sapi;
    var napi = self.napi;
    var log = self.log;
    assert.func(opts.progress, 'options.progress');

    var progress = opts.progress;

    var svcadminui;
    var svcimgapi;
    var doadminui = true;
    var doimgapi = true;

    var netexternal;

    vasync.pipeline({ funcs: [
        // Look up details for the adminui, imgapi instances.
        function (_, next) {
            getInstance('adminui', function (err, inst) {
                if (err) {
                    return cb(err);
                }
                svcadminui = inst;
                next();
            });
        },
        function (_, next) {
            getInstance('imgapi', function (err, inst) {
                if (err) {
                    return cb(err);
                }
                svcimgapi = inst;
                next();
            });
        },
        // Grab the external network details.
        function (_, next) {
            var listOpts = { name: 'external' };
            napi.listNetworks(listOpts, function (err, nets) {
                if (err) {
                    return cb(err);
                }

                if (!nets.length) {
                    return cb(new Error(
                        'Couldn\'t find external network in NAPI'));
                }

                netexternal = nets[0];
                next();
            });
        },
        // Check what NICS the imgapi and adminui zones currently have. Only do
        // work for those which do not yet have an external nic.
        function (_, next) {
            var listOpts = {
                belongs_to_type: 'zone',
                belongs_to_uuid: [ svcimgapi.uuid, svcadminui.uuid ]
            };
            napi.listNics(listOpts, function (err, nics) {
                if (err) {
                    return cb(err);
                }

                if (!nics.length) {
                    return cb(new Error(
                        'Couldn\'t find NICs for imgapi or adminui'));
                }

                for (var i = 0, nic; i < nics.length; i++) {
                    nic = nics[i];
                    if (nic.belongs_to_uuid === svcadminui.uuid &&
                        nic.nic_tag === 'external')
                    {
                        doadminui = false;
                    } else if (nic.belongs_to_uuid === svcimgapi.uuid &&
                        nic.nic_tag === 'external')
                    {
                        doimgapi = false;
                    }
                }

                next();
            });
        },
        function (_, next) {
            if (!doadminui) {
                log.warn('Skipping adminui: it already has an external nic');
                return next();
            }
            addExternaNicToZone(svcadminui, function (err) {
                if (err) {
                    return next(err);
                }
                progress('Added external nic to adminui');
                next();
            });
        },
        function (_, next) {
            if (!doimgapi) {
                log.warn('Skipping imgapi: it already has an external nic');
                return next();
            }
            addExternaNicToZone(svcimgapi, function (err) {
                if (err) {
                    return next(err);
                }
                progress('Added external nic to imgapi');
                next();
            });
        }
    ]}, function (err) {
        cb();
    });

    function getInstance(svcname, callback) {
        sapi.listServices({ name: svcname }, onServices);

        function onServices(err, svcs) {
            if (err) {
                return cb(err);
            }
            if (!svcs.length) {
                return cb(new Error(
                    'Couldn\'t find imgapi SAPI service'));
            }

            sapi.listInstances({ service_uuid: svcs[0].uuid },
            function (listerr, inst) {
                if (listerr) {
                    return cb(listerr);
                }
                callback(null, inst[0]);
            });
        }
    }

    function addExternaNicToZone(svcobj, callback) {
        var addparams = {
            uuid: svcobj.uuid,
            networks: [
                { 'uuid': netexternal.uuid, primary: true }
            ]
        };
        self.vmapi.addNics(addparams, function (err) {
            if (err) {
                return cb(err);
            }
            callback();
        });
    }
};


//---- exports

module.exports = SdcAdm;
