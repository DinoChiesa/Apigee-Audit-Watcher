// simplelogger.js
// ------------------------------------------------------------------
//
// created: Tue Nov 12 14:01:24 2019
// last saved: <2019-November-12 14:34:15>

/* jshint esversion:9, node:true, strict:implied */
/* global process, console, Buffer */

const util = require('util');

function logger(arg) {
  this.gStatus = arg;
};

logger.prototype.init = function(global) {
  this.gStatus = global;
}

logger.prototype.write = function(level) {
    if (this.gStatus.loglevel >= level) {
      let time = (new Date()).toString(),
          tstr = '[' + time.substr(11, 4) + '-' +
        time.substr(4, 3) + '-' + time.substr(8, 2) + ' ' +
        time.substr(16, 8) + '] ',
          allButFirst = [].slice.call(arguments, 1);
      console.log(tstr + util.format.apply(null, allButFirst));
    }
};


module.exports = logger;
