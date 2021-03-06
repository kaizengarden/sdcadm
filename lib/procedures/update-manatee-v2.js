/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */


var p = console.log;
var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util'),
    format = util.format;
var child_process = require('child_process'),
    execFile = child_process.execFile,
    spawn = child_process.spawn;
var fs = require('fs');
var path = require('path');
var os = require('os');
var vasync = require('vasync');

var errors = require('../errors'),
    InternalError = errors.InternalError;
var common = require('../common');
var vmadm = require('../vmadm');
var svcadm = require('../svcadm');

var Procedure = require('./procedure').Procedure;
var s = require('./shared');

/**
 * Update manatee service.
 *
 * HA is assumed and, when not present, a temporary manateeXtmp instance will
 * be created (and destroyed once update is finished).
 *
 */

function UpdateManateeV2(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateManateeV2, Procedure);

UpdateManateeV2.prototype.summarize = function manateev2Summarize() {
    var c0 = this.changes[0];
    var img = c0.image;
    var out = [sprintf('update "%s" service to image %s (%s@%s)',
                    c0.service.name, img.uuid, img.name, img.version)];
    if (c0.insts) {
        out[0] += ':';
        out = out.concat(c0.insts.map(function (inst) {
            return common.indent(sprintf('instance "%s" (%s) in server %s',
                inst.zonename, inst.alias, inst.server));
        }));
    }
    return out.join('\n');
};


UpdateManateeV2.prototype.execute = function manateev2Execute(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.func(cb, 'cb');
    var self = this;
    var log = opts.log;
    var progress = opts.progress;
    var sdcadm = opts.sdcadm;

    // We need this many times
    function getShardStatusLocally(manateeUUID, callback) {
        var argv = [
            '/usr/sbin/zlogin',
            manateeUUID,
            'source ~/.bashrc; ' +
                '/opt/smartdc/manatee/node_modules/.bin/manatee-adm status'
        ];

        common.execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            if (err) {
                return callback(err);
            }
            // REVIEW: Shall we try/catch here?
            var manateeShard = JSON.parse(stdout);
            return callback(null, manateeShard);
        });
    }


    function getShardStatus(server, manateeUUID, callback) {
        var argv = [
            '/opt/smartdc/bin/sdc-oneachnode',
            '-j',
            format('-n %s ', server),
            format('/usr/sbin/zlogin %s ', manateeUUID) +
            '\'source ~/.bashrc; ' +
                '/opt/smartdc/manatee/node_modules/.bin/manatee-adm status\''
        ];

        common.execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            if (err) {
                return callback(err);
            }
            var res = JSON.parse(stdout);
            var manateeShard = JSON.parse(res[0].result.stdout.trim());
            return callback(null, manateeShard);
        });
    }

    function disableManatee(server, zone, callback) {
        log.trace({
            server: server,
            zone: zone
        }, 'Disabling manatee services (sdc-oneachnode)');
        var argv = [
            '/opt/smartdc/bin/sdc-oneachnode',
            format('-n %s ', server),
            format('svcadm -z %s disable -s manatee-sitter; ', zone) +
            format('svcadm -z %s disable -s manatee-snapshotter; ', zone) +
            format('svcadm -z %s disable -s manatee-backupserver;', zone)
        ];
        common.execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            if (err) {
                callback(err);
            } else {
                callback();
            }
        });
    }


    function restartSitter(server, zone, callback) {
        log.trace({
            server: server,
            zone: zone
        }, 'Restarting manatee sitter (sdc-oneachnode)');
        var argv = [
            '/opt/smartdc/bin/sdc-oneachnode',
            format('-n %s ', server),
            format('/usr/sbin/svcadm -z %s restart manatee-sitter', zone)
        ];
        common.execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            if (err) {
                callback(err);
            } else {
                callback();
            }
        });

    }

    // Same than imgadmInstall but through sdc-oneachnode
    function imgadmInstallRemote(server, img, callback) {
        return s.imgadmInstallRemote({
            server: server,
            img: img,
            progress: progress,
            log: log
        }, callback);
    }

    // Reprovision through sdc-oneachnode
    function reprovisionRemote(server, zonename, img, callback) {
        return s.reprovisionRemote({
            server: server,
            img: img,
            zonename: zonename,
            progress: progress,
            log: log
        }, callback);
    }
    // Wait for manatee given state
    function waitForManatee(state, server, zone, callback) {
        var counter = 0;
        var limit = 180;
        function _waitForStatus() {
            getShardStatus(server, zone, function (err, obj) {
                counter += 1;

                if (err) {
                    return callback(err);
                }

                var mode = 'transition';
                var up;
                if (!obj.sdc) {
                    mode = 'transition';
                } else if (Object.keys(obj.sdc).length === 0) {
                    mode = 'empty';
                } else if (obj.sdc.primary && obj.sdc.sync && obj.sdc.async) {
                    up = obj.sdc.async.repl && !obj.sdc.async.repl.length &&
                        Object.keys(obj.sdc.async.repl).length === 0;
                    if (up && obj.sdc.sync.repl &&
                        obj.sdc.sync.repl.sync_state === 'async') {
                        mode = 'async';
                    }
                } else if (obj.sdc.primary && obj.sdc.sync) {
                    up = obj.sdc.sync.repl && !obj.sdc.sync.repl.length &&
                        Object.keys(obj.sdc.sync.repl).length === 0;
                    if (up && obj.sdc.primary.repl &&
                            obj.sdc.primary.repl.sync_state === 'sync') {
                        mode = 'sync';
                    }
                } else if (obj.sdc.primary) {
                    up = obj.sdc.primary.repl && !obj.sdc.primary.repl.length &&
                        Object.keys(obj.sdc.primary.repl).length === 0;
                    if (up) {
                        mode = 'primary';
                    }
                }

                if (mode === state) {
                    return callback(null);
                }

                if (counter < limit) {
                    return setTimeout(_waitForStatus, 5000);
                } else {
                    return callback(format(
                        'Timeout (15m) waiting for manatee to reach %s',
                        state));
                }

            });
        }
        _waitForStatus();
    }


    function waitForDisabled(server, inst, flag, callback) {
        var counter = 0;
        var limit = 12;
        function _waitForDisabled() {
            var argv = [
                '/opt/smartdc/bin/sdc-oneachnode',
                '-j',
                format('-n %s', server),
                format('/usr/sbin/zlogin %s ', inst) +
                format('\'json %s < ' +
                        '/opt/smartdc/manatee/etc/sitter.json\'', flag)
            ];
            common.execFilePlus({
                argv: argv,
                log: log
            }, function (err, stdout, stderr) {
                if (err) {
                    callback(err);
                } else {
                    var res = JSON.parse(stdout.trim());
                    counter += 1;
                    if (res[0].result.stdout.trim() === 'false') {
                        callback();
                    } else {
                        if (counter < limit) {
                            return setTimeout(_waitForDisabled, 5000);
                        } else {
                            return callback(format(
                                'Timeout (60s) waiting for config flag' +
                                ' %s to be disabled', flag));
                        }

                    }
                }
            });
        }
        _waitForDisabled();
    }


    function waitForEnabled(server, zuuid, flag, callback) {
        var counter = 0;
        var limit = 12;
        function _waitForEnabled() {
            var argv = [
                '/opt/smartdc/bin/sdc-oneachnode',
                '-j',
                format('-n %s', server),
                format('/usr/sbin/zlogin %s ', zuuid) +
                format('\'json %s < ' +
                        '/opt/smartdc/manatee/etc/sitter.json\'', flag)
            ];
            common.execFilePlus({
                argv: argv,
                log: self.log
            }, function (err, stdout, stderr) {
                if (err) {
                    callback(err);
                } else {
                    var res = JSON.parse(stdout.trim());
                    counter += 1;
                    if (res[0].result.stdout.trim() === 'true') {
                        callback();
                    } else {
                        if (counter < limit) {
                            return setTimeout(_waitForEnabled, 5000);
                        } else {
                            return callback(format(
                                'Timeout (60s) waiting for config flag' +
                                ' %s to be enabled', flag));
                        }

                    }
                }
            });
        }
        _waitForEnabled();
    }


    function waitForPostgresUp(server, zone, callback) {
        var counter = 0;
        var limit = 36;
        function _waitForPostgresUp() {
            var args = [
                format('-n %s ', server),
                format('/usr/sbin/zlogin %s ', zone) +
                '\'/opt/local/bin/psql -U postgres -t -A -c ' +
                '"SELECT NOW() AS when;"\''
            ];

            var child = spawn('/opt/smartdc/bin/sdc-oneachnode', args);
            var stdout = [];
            var stderr = [];
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', function (so) {
                stdout.push(so);
            });
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', function (se) {
                stderr.push(se);
            });

            child.on('close', function vmadmDone(code, signal) {
                stdout = stdout.join('');
                stderr = stderr.join('');
                log.debug({
                    code: code,
                    signal: signal,
                    stdout: stdout,
                    stderr: stderr
                }, 'Ping PostgreSQL');
                if ((code || signal)) {
                    if (counter < limit) {
                        return setTimeout(_waitForPostgresUp, 5000);
                    } else {
                        return callback('Timeout (60s) waiting for Postgres');
                    }
                } else {
                    return callback();
                }
            });
        }
        _waitForPostgresUp();
    }



    function updateManatee(change, nextSvc) {
        var arg = {
            change: change,
            opts: opts,
            userScript: false,
            HA: false,
            shard: {
            }
        };
        var manateeUUID;
        var sapiUUID;

        if (change.insts && change.insts.length > 1) {
            arg.HA = true;
        }

        var funcs = [
            s.getUserScript,
            s.writeOldUserScriptForRollback,
            s.updateSvcUserScript
        ];

        if (!arg.HA) {
            funcs.push(s.updateVmUserScript);
        } else {
            change.insts.forEach(function (i) {
                funcs.push(function updateInstUserScript(_, next) {
                    s.updateVmUserScriptRemote({
                        service: change.service,
                        progress: progress,
                        zonename: i.zonename,
                        log: opts.log,
                        server: i.server,
                        userScript: arg.userScript
                    }, next);
                });
            });
        }

        vasync.pipeline({funcs: funcs.concat([

            s.updateSapiSvc,

            function getLocalManatee(_, next) {
                progress('get local manatee');
                if (!arg.HA) {
                    manateeUUID = change.inst.zonename;
                } else {
                    var hostname = os.hostname();
                    manateeUUID = change.insts.filter(function (x) {
                        return (x.hostname === hostname);
                    })[0].zonename;
                }
                log.debug('Local manatee instance found: %s', manateeUUID);
                next();
            },

            function getShard(_, next) {
                progress('Running manatee-adm status in local manatee');
                getShardStatusLocally(manateeUUID, function (err, st) {
                    if (err) {
                        return next(err);
                    }
                    Object.keys(st.sdc).forEach(function (m) {
                        arg.shard[m] = st.sdc[m];
                    });
                    return next();
                });
            },

            function getShardServers(_, next) {
                progress('Getting Compute Nodes Information for manatee VMs');
                if (!arg.HA) {
                    arg.shard.primary.server_uuid =
                        change.inst.server;
                    return next();
                }
                var servers = {};
                vasync.forEachParallel({
                    inputs: Object.keys(arg.shard).map(function (m) {
                        return (arg.shard[m].zoneId);
                    }),
                    func: function getManateeServer(vm_uuid, callback) {
                        servers[vm_uuid] = change.insts.filter(function (x) {
                            return (x.zonename === vm_uuid);
                        })[0].server;
                        callback();
                    }
                }, function (err, result) {
                    if (err) {
                        return next(err);
                    }
                    Object.keys(arg.shard).forEach(function (m) {
                        arg.shard[m].server_uuid = servers[arg.shard[m].zoneId];
                    });
                    return next();
                });
            },

            function installPrimaryImage(_, next) {
                if (!arg.HA) {
                    return s.imgadmInstall(arg, next);
                } else {
                    progress('Installing image %s (%s@%s) on server %s',
                        arg.change.image.uuid, arg.change.image.name,
                        arg.change.image.version,
                        arg.shard.primary.server_uuid);

                    imgadmInstallRemote(arg.shard.primary.server_uuid,
                            arg.change.image, next);
                }
            },

            // --------------- HA only --------------------------------------
            function verifyFullHA(_, next) {
                if (!arg.HA) {
                    return next();
                }

                progress('Verifying full HA setup');
                if (!arg.shard.sync || !arg.shard.async) {
                    progress(
                        'Incomplete HA setup. Please, finish manatee setup' +
                        'and make sure primary, sync and async peers are ' +
                        'running before trying manatee update.');
                    next('HA setup error');
                }

                return next();
            },

            function disableAsync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Disabling "async" manatee');
                disableManatee(arg.shard.async.server_uuid,
                        arg.shard.async.zoneId, next);
            },

            function waitForAsyncDisabled(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Waiting for manatee shard to reach "sync" status');
                waitForManatee('sync', arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, next);
            },

            function installImageAsyncServer(_, next) {
                if (!arg.HA) {
                    return next();
                }

                if (arg.shard.async.server_uuid ===
                        arg.shard.primary.server_uuid) {
                    return next();
                }

                progress('Installing image %s (%s@%s) on server %s',
                    arg.change.image.uuid, arg.change.image.name,
                    arg.change.image.version, arg.shard.async.server_uuid);

                imgadmInstallRemote(arg.shard.async.server_uuid,
                        arg.change.image, next);
            },

            function reprovisionAsync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Reprovisioning "async" manatee');
                reprovisionRemote(arg.shard.async.server_uuid,
                        arg.shard.async.zoneId, arg.change.image, next);
            },

            function waitForAsync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Wait (60s) for manatee instance %s to come up',
                    arg.shard.async.zoneId);
                setTimeout(next, 60 * 1000);
            },

            function waitForHA(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Waiting for manatee shard to reach "async" status');
                waitForManatee('async', arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, next);
            },

            function disableSync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Disabling "sync" manatee');
                disableManatee(arg.shard.sync.server_uuid,
                        arg.shard.sync.zoneId, next);
            },

            function waitForSyncDisabled(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Waiting for manatee shard to reach "sync" status');
                waitForManatee('sync', arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, next);
            },

            function installImageSyncServer(_, next) {
                if (!arg.HA) {
                    return next();
                }

                if ((arg.shard.sync.server_uuid ===
                        arg.shard.primary.server_uuid) ||
                        (arg.shard.sync.server_uuid ===
                         arg.shard.async.server_uuid)) {
                    return next();
                }

                progress('Installing image %s (%s@%s) on server %s',
                    arg.change.image.uuid, arg.change.image.name,
                    arg.change.image.version, arg.shard.sync.server_uuid);

                imgadmInstallRemote(arg.shard.sync.server_uuid,
                        arg.change.image, next);
            },


            function reprovisionSync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Reprovisioning "sync" manatee');
                reprovisionRemote(arg.shard.sync.server_uuid,
                        arg.shard.sync.zoneId, arg.change.image, next);
            },

            function waitForSync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Wait (60s) for manatee instance %s to come up',
                    arg.shard.sync.zoneId);
                setTimeout(next, 60 * 1000);
            },

            function waitForHASync(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Waiting for manatee shard to reach "async" status');
                waitForManatee('async', arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, next);
            },

            function disablePrimaryManatee(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Disabling manatee services on "primary" manatee');
                disableManatee(arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, next);
            },

            function waitForShardPromotion(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Waiting for shard promotion before "primary" update');
                var counter = 0;
                var limit = 36;
                function _waitForShardPromotion() {
                    getShardStatus(arg.shard.async.server_uuid,
                            arg.shard.async.zoneId,
                            function (err, shard) {
                        if (err) {
                            return next(err);
                        }
                        if (shard.sdc.primary.zoneId !==
                            arg.shard.primary.zoneId) {
                            return next();
                        } else {
                            if (counter < limit) {
                                return setTimeout(_waitForShardPromotion, 5000);
                            } else {
                                return next('Timeout (3min) waiting ' +
                                    'for shard promotion');
                            }
                        }
                    });
                }
                _waitForShardPromotion();
            },

            // --------------- no-HA ------------------------------------------
            // Just in case of no-HA: We need to hack SAPI_PROTO_MODE and turn
            // it back on during the time we're gonna have manatee down.
            // Otherwise, config-agent will try to publish the manatee zone IP
            // to SAPI and, if in full mode, it will obviously fail due to no
            // manatee.
            function getLocalSapi(_, next) {
                if (arg.HA) {
                    return next();
                }
                progress('Running vmadm lookup to get local sapi');
                var argv = [
                    '/usr/sbin/vmadm',
                    'lookup',
                    'state=running',
                    'alias=~sapi'
                ];
                common.execFilePlus({
                    argv: argv,
                    log: log
                }, function (err, stdout, stderr) {
                    if (err) {
                        next(err);
                    } else {
                        var sapis = stdout.trim().split('\n');
                        sapiUUID = sapis[0];
                        log.debug('Local sapi instance found: %s',
                            sapiUUID);
                        next();
                    }
                });
            },
            // Do not try this at home!. This is just a hack for no-HA setups,
            // solely for testing/development purposes; any reasonable manatee
            // setup must have HA.
            function setSapiProtoMode(_, next) {
                if (arg.HA) {
                    return next();
                }
                progress('Hackish way to set SAPI back to proto mode');
                var argv = [
                    '/usr/sbin/zlogin',
                    sapiUUID,
                    '/usr/sbin/mdata-put SAPI_PROTO_MODE true'
                ];
                common.execFilePlus({
                    argv: argv,
                    log: log
                }, function (err, stdout, stderr) {
                    if (err) {
                        next(err);
                    } else {
                        next();
                    }
                });
            },

            function restartSapiIntoProtoMode(_, next) {
                if (arg.HA) {
                    return next();
                }
                progress('Restarting SAPI in proto mode');
                svcadm.svcadmRestart({
                    zone: sapiUUID,
                    fmri: '/smartdc/application/sapi:default',
                    log: log
                }, next);
            },

            // ---- Shared between HA and no-HA -------------------------------
            function reprovisionPrimary(_, next) {
                return reprovisionRemote(arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, arg.change.image, next);
            },

            function waitForPrimaryInstance(_, next) {
                // For now we are using the lame 60s sleep from incr-upgrade's
                // upgrade-all.sh.
                // TODO: improve this to use instance "up" checks from TOOLS-551
                progress('Wait (60s) for manatee instance %s to come up',
                    arg.shard.primary.zoneId);
                setTimeout(next, 60 * 1000);
            },

            // ----------- Again, no-HA only ----------------------------------
            function waitForPrimaryPG(_, next) {
                if (arg.HA) {
                    return next();
                }
                waitForPostgresUp(arg.shard.primary.server_uuid,
                        arg.shard.primary.zoneId, next);
            },

            function resetSapiToFullMode(_, next) {
                if (arg.HA) {
                    return next();
                }
                progress('Restoring SAPI to full mode');
                sdcadm.sapi.setMode('full', next);
            },

            // ------------ And, finally, the last HA one ---------------------
            function waitForShardHA(_, next) {
                if (!arg.HA) {
                    return next();
                }
                progress('Waiting for manatee shard to reach "async" status');
                waitForManatee('async', arg.shard.async.server_uuid,
                        arg.shard.async.zoneId, next);
            }

        ]), arg: arg}, nextSvc);
    }

    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateManatee
    }, cb);

};


//---- exports

module.exports = {
    UpdateManateeV2: UpdateManateeV2
};
// vim: set softtabstop=4 shiftwidth=4:
