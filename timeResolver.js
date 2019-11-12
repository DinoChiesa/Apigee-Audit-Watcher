/* jshint esversion:9, node:true, strict:implied */
/* global process, console, Buffer */

const pattern = new RegExp('^([1-9][0-9]*)([smhdw])$','i');
const multipliers = {s: 1, m: 60, h : 60*60, d:60*60*24, w: 60*60*24*7 };
const labels = {s: 'seconds', m: 'minutes', h : 'hours', d:'days', w: 'weeks' };

/*
 * convert a simple timespan string, expressed in days, hours, minutes, or
 * seconds, such as 30d, 12d, 8h, 24h, 45m, 30s, into a numeric quantity in
 * milliseconds.
 */
function timeIntervalToMilliseconds(subject) {
  var match = pattern.exec(subject);
  if (match) {
    return match[1] * multipliers[match[2]] * 1000;
  }
  return -1;
}

function timeIntervalToPhrase(subject) {
  var match = pattern.exec(subject);
  let quantity = 'unknown',
      label = 'milliseconds';
  if (match) {
    quantity = Number(match[1]);
    label = labels[match[2]];
  }
  else {
    quantity = Number(subject);
  }

  if (quantity == 1) {
    label = label.substring(0, label.length - 1);
  }
  return quantity + ' ' + label;
}


module.exports = {
    timeIntervalToMilliseconds, timeIntervalToPhrase
};
