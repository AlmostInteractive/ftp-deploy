"use strict";

const upath = require("upath");
const util = require("util");
const events = require("events");
const Promise = require("bluebird");
const fs = require("fs");

var PromiseFtp = require("promise-ftp");
const lib = require("./lib");

/* interim structure
{
    '/': ['test-inside-root.txt'],
    'folderA': ['test-inside-a.txt'],
    'folderA/folderB': ['test-inside-b.txt'],
    'folderA/folderB/emptyC': [],
    'folderA/folderB/emptyC/folderD': ['test-inside-d-1.txt', 'test-inside-d-2.txt']
}
*/

const FtpDeployer = function () {
    // The constructor for the super class.
    events.EventEmitter.call(this);
    this.ftp = null;
    this.eventObject = {
        totalFilesCount: 0,
        transferredFileCount: 0,
        filename: ""
    };

    this.makeAllAndUpload = function (remoteDir, filemap) {
        let keys = Object.keys(filemap);
        return Promise.mapSeries(keys, key => {
            // console.log("Processing", key, filemap[key]);
            return this.makeAndUpload(remoteDir, key, filemap[key]);
        });
    };

    // Creates a remote directory and uploads all of the files in it
    // Resolves a confirmation message on success
    this.makeAndUpload = (config, relDir, fnames) => {
        let newDirectory = upath.join(config.remoteRoot, relDir);
        return this.ftp
            .mkdir(newDirectory, true)
            .then(() => {
                // console.log("newDirectory", newDirectory);
                return Promise.mapSeries(fnames, fname => {
                    let tmpFileName = upath.join(
                        config.localRoot,
                        relDir,
                        fname
                    );
                    let tmp = fs.readFileSync(tmpFileName);
                    this.eventObject["filename"] = upath.join(relDir, fname);

                    this.emit("uploading", this.eventObject);

                    return this.ftp
                        .put(tmp, upath.join(config.remoteRoot, relDir, fname))
                        .then(() => {
                            this.eventObject.transferredFileCount++;
                            this.emit("uploaded", this.eventObject);
                            return Promise.resolve("uploaded " + tmpFileName);
                        })
                        .catch(err => {
                            this.eventObject["error"] = err;
                            this.emit("upload-error", this.eventObject);
                            // if continue on error....
                            return Promise.reject(err);
                        });
                });
            });
    };

    // connects to the server, Resolves the config on success
    this.connect = config => {
        this.ftp = new PromiseFtp();

        return this.ftp.connect(config).then(serverMessage => {
            this.emit("log", "Connected to: " + config.host);
            this.emit("log", "Connected: Server message: " + serverMessage);

            return config;
        });
    };

    // creates list of all files to upload and starts upload process
    this.checkLocalAndUpload = config => {
        let filemap = lib.parseLocal(
            config.include,
            config.exclude,
            config.localRoot,
            "/"
        );
        // console.log(filemap);

        this.eventObject["totalFilesCount"] = lib.countFiles(filemap);

        return this.makeAllAndUpload(config, filemap);
    };

    // Deletes remote directories if requested by config
    // Returns config
    this.deleteRemote = config => {
        if (config.deleteRemote) {
            if (!Array.isArray(config.deleteRemote)) {
                throw new Error('deleteRemote must be an array');
            }

            return Promise.mapSeries(config.deleteRemote, dir => {
                this.emit("log", "Deleting directory: " + config.remoteRoot + dir);
                return lib.deleteDir(this.ftp, config.remoteRoot + dir);
            }).then(() => config);
        }
        return Promise.resolve(config);
    };

    this.rename = config => {
        if (config.renameRemote) {
            if (!Array.isArray(config.renameRemote)) {
                throw new Error('v must be an array');
            }

            return Promise.mapSeries(config.renameRemote, pair => {
                this.emit("log", "Renaming file: " + config.remoteRoot + pair[0] + ' -> ' +  pair[1]);

                return this.ftp
                    .rename(pair[0], pair[1])
                    .then(() => {
                        this.emit("renamed", this.eventObject);
                        return Promise.resolve("renamed " + pair[0] + ' -> ' +  pair[1]);
                    })
                    .catch(err => {
                        this.eventObject["error"] = err;
                        this.emit("rename-error", this.eventObject);
                        // if continue on error....
                        return Promise.reject(err);
                    });
            }).then(() => config);
        }
        return Promise.resolve(config);
    };

    this.deploy = function (config, cb) {
        return lib
            .checkIncludes(config)
            .then(lib.getPassword)
            .then(this.connect)
            .then(this.deleteRemote)
            .then(this.checkLocalAndUpload)
            .then(this.rename)
            .then(res => {
                this.ftp.end();
                if (typeof cb == "function") {
                    cb(null, res);
                } else {
                    return Promise.resolve(res);
                }
            })
            .catch(err => {
                if (
                    this.ftp &&
                    this.ftp.getConnectionStatus() != "disconnected"
                )
                    this.ftp.end();
                if (typeof cb == "function") {
                    cb(err, null);
                } else {
                    return Promise.reject(err);
                }
            });
    };
};

util.inherits(FtpDeployer, events.EventEmitter);

module.exports = FtpDeployer;
