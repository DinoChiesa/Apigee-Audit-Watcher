// auditWatcher.js
// ------------------------------------------------------------------
//
// A 'daemon' that periodically wakes up, queries the Apigee audit trail, and
// then fires webhooks appropriately.
//
// To use this, you must provide config.json - a file containing configuration info.
// It should be in the directory named 'config', a child of the current directory.
//
// config.json looks like this:
//
// {
//   "organization": "myorgname",
//   "sleepTime" : "10m",
//   "auth" : {
//     "netrc" : true
//   },
//   "alert" : {
//     "type" : "slack",
//     "iconUrl" : "https://url.to/image/for/slackpost",
//     "uri" : "https://hooks.slack.com/services/URL/THAT/ACCEPTS/POSTS"
//   }
// }
//
// See the README.md for more information.
//
// created: Wed Dec  2 17:23:33 2015
// last saved: <2019-November-12 15:06:46>

/* global process console Buffer */
/* jshint node:true, esversion:9, strict:implied */

const qs = require ('querystring'),
      fs = require('fs'),
      os = require('os'),
      netrc = require('netrc'),
      path = require('path'),
      util = require('util'),
      timeResolver = require('./timeResolver.js'),
      handlebars = require('handlebars'),
      moment = require('moment-timezone'),
      httpRequest = require('request'),
      bodyParser = require('body-parser'),
      sprintf = require("sprintf-js").sprintf,
      app = require('express')(),
      Logger = require('./simplelogger.js'),
      oneDayInMilliseconds = 60 * 60 * 24 * 1000,
      tenHoursInMilliseconds = 60 * 60 * 10 * 1000,
      lookbackInterval = tenHoursInMilliseconds,
      runtimeGracePeriodSeconds = 240,
      apiBase = 'https://api.enterprise.apigee.com',
      loginBaseUrl = 'https://login.apigee.com', // will vary if SSO is used
      defaultBasicAuthBlobForApigeeLogin = 'ZWRnZWNsaTplZGdlY2xpc2VjcmV0',
      auditBase = apiBase + '/v1/audits/organizations/',
      dateformat = 'YYYY MMMM D H:mm:ss';

var gConfig;
var gTz;
var previousAuditRecords;
var defaults = {
      iconUrl: 'https://yt3.ggpht.com/a/AGF-l7_ahLayWFLAgeXEVNG3LC8il4bAfMq-wOLqHw=s900-c-k-c0xffffffff-no-rj-mo'
    };

var gStatus = {
      version : '20191112-0944',
      times : {
        start : moment().tz('GMT').format()
      },
      nRequests : 0,
      status : 'none',
      loglevel: 3,  // higher means more logging
      alertCounts : { total: 0 }
    };

var log = new Logger(gStatus);

function getType(obj) {
  return Object.prototype.toString.call(obj);
}

function copyHash(obj) {
  var copy = {};
  if (null !== obj && typeof obj == "object") {
    Object.keys(obj).forEach(function(attr){copy[attr] = obj[attr];});
  }
  return copy;
}

function request(options, cb) {
  log.write(1, '%s %s', options.method.toUpperCase(), options.uri);
  //console.log(JSON.stringify(options, null, 2));
  return httpRequest(options, function(e, httpResp, body) {
    if (e) {
      log.write(1, '==> Error %s', e);
      return cb(e, httpResp, body);
    }
    log.write(1, '==> %d', httpResp.statusCode);
    //console.log(body);
    return cb(e, httpResp, body);
  });
}


function enhanceTokenResponse(tokenResponse) {
  var iso = {};
  if (tokenResponse.access_token) {
    //console.log('token: ' + JSON.stringify(token, null, 2));
    let parts = tokenResponse.access_token.split(new RegExp('\\.'));
    if (parts && parts.length == 3) {
      try {
        let payload = Buffer.from(parts[1], 'base64').toString('utf-8'),
            claims = JSON.parse(payload);
        // The issued_at and expires_in properties on the token
        // WRAPPER are inconsistent with the actual token. So let's
        // overwrite them.
        if (claims.iat) {
          let d = new Date(claims.iat * 1000);
          tokenResponse.issued_at = d.getTime(); // milliseconds
          iso.issued_at = d.toISOString();
        }
        if (claims.exp) {
          let d = new Date(claims.exp * 1000);
          iso.expires = d.toISOString();
          tokenResponse.expires = claims.exp;
          tokenResponse.expires_in = claims.exp - claims.iat; // seconds
        }
      }
      catch (e) {
        // not a JWT; probably a googleapis opaque oauth token
        if (tokenResponse.issued_at) {
          let d = new Date(tokenResponse.issued_at);
          iso.issued_at = d.toISOString();
          if (tokenResponse.expires_in) {
            let d = new Date(tokenResponse.issued_at + tokenResponse.expires_in * 1000);
            iso.expires = d.toISOString();
          }
        }
      }
    }
  }
  tokenResponse.ISO = iso;
  return tokenResponse;
}


function invokeApigeeTokenEndpoint(ctx) {
  return new Promise((resolve, reject) => {
    let formparams = ctx.authformparams,
        requestOptions = {
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'Authorization' : 'Basic ' + defaultBasicAuthBlobForApigeeLogin
          },
          method: 'post',
          body : qs.stringify(formparams),
          uri : loginBaseUrl + '/oauth/token'
        };

    request(requestOptions, function(e, httpResp, body) {
      if (e) {
        log.write(0, 'ERROR %s during POST %s', e.message, requestOptions.url);
        return reject(e);
      }
      if (httpResp.statusCode != 200) {
        return reject(new Error(`non-success status code ${httpResp.statusCode}`));
      }

      body = JSON.parse(body);
      if (body.access_token) {
        gConfig.auth.tokenResponse = enhanceTokenResponse(body);
        gConfig.auth.authzHeader = 'Bearer ' + body.access_token;
        delete ctx.authformparams;
        return resolve(ctx);
      }

      log.write(1, "body: " + JSON.stringify(body));
      return reject(new Error("invalid token response"));
    });
  });
}


function setApigeeAuthHeader(ctx) {
  if ( ! gConfig.auth.authzHeader || !gConfig.auth.tokenResponse) {
    ctx.authformparams = {
      grant_type : 'password',
      username : gConfig.auth.username,
      password : gConfig.auth.password
    };
    return invokeApigeeTokenEndpoint(ctx);
  }

  let t = gConfig.auth.tokenResponse,
  epochSecondsNow = (new Date()).valueOf() / 1000;
  if (t.expires > epochSecondsNow + runtimeGracePeriodSeconds) {
    return Promise.resolve(ctx);
  }

  // The token is expired or will expire shortly; get a new one.
  if ( ! t.refresh_token) {
    console.log('No refresh token. Exiting.');
    process.exit(4);
  }

  ctx.authformparams = {
    grant_type : 'refresh_token',
    refresh_token: t.refresh_token
  };
  return invokeApigeeTokenEndpoint(ctx);
}



const messageProducers = {
        googlechat: function produceMessageForGoogleChat(context) {
          if (gConfig.alert.uri.indexOf('https://chat.googleapis.com') !== 0) {
            return context;
          }
          // filter out failed calls
          var a = context.alertable.filter(function(x){
                return x.responseCode != "400" && x.responseCode != "401" && x.responseCode != "500";
              });
          context.filteredAlerts = a;
          var configObj = {
                organization : gConfig.organization,
                summary : a.length + ' update' + ((a.length != 1)?"s have":" has") +
              " been made to org " + gConfig.organization,
                timeRange: (gStatus.times.lastCheck) ?
              'between ' + moment(gStatus.times.lastCheck).tz(gTz).format(dateformat) +
              ' and ' +  moment().tz(gTz).format(dateformat) :
              'since yesterday',
                watcherInfo: 'org:' + process.env.APIGEE_ORGANIZATION +
              ' env:' + process.env.APIGEE_ENVIRONMENT +
              ' ver:' + gStatus.version
              };
          var template = fs.readFileSync(path.join('templates', 'gchat.tmpl'), 'utf8');
          template = handlebars.compile(template);

          return Promise.resolve(context)
            .then(gatherElaborations)
            .then(function(c) {
              if (c.elaborations !== '') {
                configObj.elaborations = c.elaborations.replace(new RegExp('\\n', 'g'), '<br/>\n');
                c.message = {
                  "sender": {
                    "displayName": "Audit watcher Bot"
                  },
                  "cards": [
                    {
                      "sections": [
                        {
                          "widgets": [
                            {
                              "textParagraph": {
                                "text": template(configObj)
                              }
                            }
                          ]
                        }
                      ]
                    }
                  ]
                };
              }
              return c;
            });

        },

        slack: function produceMessageForSlack(context) {
          if (gConfig.alert.uri.indexOf('hooks.slack.com') === -1) {
            return context;
          }
          // filter out failed calls
          var a = context.alertable.filter(function(x){
                return x.responseCode != "400" && x.responseCode != "401" && x.responseCode != "500";
              });
          context.filteredAlerts = a;
          var text = a.length + ' update' + ((a.length != 1)?"s have":" has") +
            " been made to org " + gConfig.organization;
          var msgObject = {
                title : 'Apigee Administrative Changes',
                title_link : 'https://apigee.com/organizations/' + gConfig.organization,
                text : text,
                fallback : text,
                color: '#d08f2c',
                fields : [
                  {
                    title : "Timebox",
                    "short" : false,
                    value : (gStatus.times.lastCheck) ?
                      'between ' + moment(gStatus.times.lastCheck).tz(gTz).format(dateformat) +
                      ' and ' +  moment().tz(gTz).format(dateformat) :
                      'since yesterday'
                  },
                  { title : 'Organization', "short" : true,
                    value : gConfig.organization},
                  { title : 'Watcher Info', "short" : true,
                    value: 'hostname:' + os.hostname() +
                    ' ver:' + gStatus.version }
                ]
              };

          // curl -i -X POST https://hooks.slack.com/services/SITE/SPECIFIC/URL/HERE \
          // -d '{
          //   "icon_url" : "http://d3grn7b5c5cnw5.cloudfront.net/sites/docs/files/icon_policy_message-logging.jpg",
          //   "username": "Edge Audit Watcher",
          //   "attachments" :
          //   [ {
          //     "title" : "Apigee Edge Administrative Changes",
          //     "title_link" : "https://edge.apigee.com/platform/",
          //     "text" : "This is some text, another test of icons",
          //     "fallback" : "This is the fallback text",
          //     "color" : "#d08f2c",
          //     "fields" : [
          //       {
          //         "title" : "Timebox",
          //         "short" : false,
          //         "value" : "since a few minutes ago"
          //       },
          //       { "title" : "Organization", "short" : true,
          //         "value" : "ap-parityapi"},
          //       { "title" : "Watcher Info", "short" : true,
          //         "value" : "org:xyz env:abc"}
          //     ]
          //   }
          //   ]
          // }'

          return Promise.resolve(context)
            .then(gatherElaborations)
            .then(function(c) {
              if (c.elaborations !== '') {
                msgObject.fields.push({
                  title : "Changes",
                  "short" : false,
                  "value" : c.elaborations
                });
                c.message = {
                  icon_url : gConfig.alert.iconUrl || defaults.iconUrl,
                  username: "Apigee Audit Watcher",
                  attachments : [ msgObject ]
                };
              }
              return c;
            });
        },

        hipchat: function produceVanillaMessage(context) {
          // filter out failed calls
          var a = context.alertable.filter(function(x){
                return x.responseCode != "400" && x.responseCode != "401" && x.responseCode != "500";
              });
          context.filteredAlerts = a;
          var msg = '*Apigee Edge Updates*\n' +
            'watcher in org:' + process.env.APIGEE_ORGANIZATION +
            ' env:' + process.env.APIGEE_ENVIRONMENT + '\n' +
            context.alertable.length + ' update' +
            ((context.alertable.length != 1)? "s have":" has") +
            " been made to org " + gConfig.organization;

          if (gStatus.times.lastCheck) {
            msg += '\nbetween ' + moment(gStatus.times.lastCheck).tz(gTz).format(dateformat) +
              ' and ' +  moment().tz(gTz).format(dateformat);
          }
          else {
            msg += '\nsince yesterday';
          }

          return Promise.resolve(context)
            .then(gatherElaborations)
            .then(function(c) {
              if (c.elaborations !== '') {
                c.message = msg + ', including\n' + c.elaborations;
              }
              else {
                c.message = msg;
              }
              return c;
            });
        }
      };


// function getAuthorizationHeaderForEdgeAdmin() {
//   var credsfile = 'creds.json';
//   if ( ! edgeAuthHeader) {
//     if (fs.existsSync(credsfile)) {
//       var edgeCreds = JSON.parse(fs.readFileSync(credsfile, "utf8"));
//       edgeAuthHeader = "Basic " + new Buffer(edgeCreds.username + ":" + edgeCreds.password).toString("base64");
//     }
//     else {
//       throw new Error("missing file: " + credsfile);
//     }
//   }
//   return edgeAuthHeader;
// }

function simplePluralize(count, phrase) {
  if (count !== 1) return phrase;
  let words = phrase.split(' ');
  if ( words[words.length-2].endsWith('xies')) {
    words[words.length-2] = words[words.length-2].replace(new RegExp('xies$'),'xy');
  }
  else {
    words[words.length-2] =  words[words.length-2].replace(new RegExp('s$'),'');
  }
  return words.join(' ');
}


function produceMessage(context) {
  if (messageProducers[gConfig.alert.type]) {
    return messageProducers[gConfig.alert.type](context);
  }
  return context;
}


const resolveFns = {
      developerAppDetails: function (c) {
        c.elaborations += sprintf('\u2022 %s (dev:%s user:%s)\n', c.match[3], c.match[2], c.alert.user);
        return c;
      },
      developerAppKeyAction : function (c) {
        c.elaborations += sprintf('\u2022 app:%s product:%s (dev:%s user:%s)\n',
                                  (c.match && c.match[3]) || '-unk-',
                                  (c.match && c.match[5]) || '-unk-',
                                  (c.match && c.match[2]) || '-unk-',
                                  (c.alert && c.alert.user) || '-unk-');
        return c;
      },
      resolveDeveloperName : function (c) {
        c.elaborations += sprintf('\u2022 %s (user:%s)\n', c.match[2], c.alert.user);
        return c;
      },
      resolveApiProxyRevision : function (c) {
        c.elaborations += sprintf('\u2022 %s (rev:%s env:%s user:%s)\n', c.match[3], c.match[4], c.match[2], c.alert.user);
        return c;
      },
      resolveApiProxyRevision2 : function (c) {
        c.elaborations += sprintf('\u2022 %s (rev:%s user:%s)\n', c.match[2], c.match[3], c.alert.user);
        return c;
      },
      resolveProxyName : function (c) {
        c.elaborations += sprintf('\u2022 %s (user:%s)\n', c.match[2], c.alert.user);
        return c;
      },
      resolveApiProduct : function(c) {
        c.elaborations += sprintf('\u2022 %s (user:%s)\n', c.match[2], c.alert.user);
        return c;
      },
      resolveReportName : function(c) {
        // TODO: use a cache here
        return setApigeeAuthHeader(c)
          .then(() => new Promise((resolve, reject) => {
          var match = c.match,
              options = {
                timeout : 66000, // in ms
                uri: apiBase + '/v1/o/'+ gConfig.organization + '/reports/' + match[2],
                method: 'get',
                headers: {
                  'authorization' : gConfig.auth.authzHeader,
                  'accept' : 'application/json',
                  'user-agent' : 'audit-watcher-1'
                }
              };
            request(options, function(e, httpResp, body) {
              var s = '';
              if (e) {
                log.write(2, 'details query failed: ' + e);
              }
              else if (httpResp.statusCode == 200) {
                if (typeof body == 'string' && body.trim() !== '') {
                  try {
                    body = JSON.parse(body);
                    s = sprintf('\u2022 %s (user:%s)\n', body.displayName, c.alert.user);
                    c.elaborations += s;
                  }
                  catch(exc1) { }
                }
              }
              return resolve(c);
            });
          }));
      },
      resolveDeletedReportName : function(c) {
        c.elaborations += sprintf('\u2022 %s (user:%s)\n', c.match[2], c.alert.user);
        return c;
      },
      resolveTraceSession : function(c) {
        c.elaborations += sprintf('\u2022 proxy:%s (rev:%s env:%s user:%s)\n', c.match[3], c.match[4], c.match[2], c.alert.user);
        return c;
      }
    };


function gatherElaborations(context) {
  // get elaborations and details
  var s1 = '/v1/(organizations|o)/'+ gConfig.organization;
  // eg,
  // {
  //   "operation": "CREATE",
  //   "request": "''Prod2''",
  //   "requestUri": "/v1/organizations/cap250/developers/W35yptYHyVyBjloZ/apps/gd1/keys/TLRc5m0Zv0cSD1MAoei6eQKhevgE3OGy/apiproducts/Prod2?action=approve",
  //   "responseCode": "204",
  //   "timeStamp": 1449688834257,
  //   "user": "DChiesa@apigee.com"
  // },
  // {
  //    "operation": "CREATE",
  //    "request": "''ap-parityapi''",
  //    "requestUri": "/v1/organizations/ap-parityapi/reports/aa35a9f8-79dc-4d3c-be66-07140612eb1e/",
  //    "responseCode": "201",
  //    "timeStamp": 1455046522101,
  //    "user": "DChiesa@apigee.com"
  // },
  // {
  //    "operation": "CREATE",
  //    "request": "''ap-parityapi''",
  //    "requestUri": "/v1/organizations/ap-parityapi/environments/main/apis/parity-test14/revisions/20/debugsessions/1455043863266/?session=1455043863266&timeout=600",
  //    "responseCode": "201",
  //    "timeStamp": 1455043864283,
  //    "user": "gdingle-cw@starbucks.com"
  // },

  // each check is a string in 4 parts, joined by |
  //  0. verb
  //  1. status code
  //  2. path regex
  //  3. the sentence fragment in plural form
  //  4. (optional) the name of the fn to invoke
  //
  // optionally, the 4th item is the name of a function that is
  //    called to provide additional details about the item. The function gets
  //    called with the context, containing the alert, and the regex match
  //    result.  This fn should append to c.elaborations with details about
  //    the change.  The name is looked up in the resolveFns array.

  var checks = [
        'DELETE|200|/developers/([^/]+)/apps/([^/]+)$|dev apps deleted|developerAppDetails',
        'CREATE|201|/developers/([^/]+)/apps/([^/]+)/$|dev apps created|developerAppDetails',
        'UPDATE|200|/developers/([^/]+)/apps/([^/]+)$|developer apps updated|developerAppDetails',
        'CREATE|204|/developers/([^/]+)/apps/([^/]+)/keys/([^/]+)/apiproducts/([^/]+)\\?action=approve$|dev app keys approved|developerAppKeyAction' ,
        'CREATE|204|/developers/([^/]+)/apps/([^/]+)/keys/([^/]+)/apiproducts/([^/]+)\\?action=revoke$|dev app keys revoked|developerAppKeyAction' ,
        'UPDATE|200|/developers/([^/]+)/apps/([^/]+)/keys/([^/]+)$|developer app keys updated|developerAppDetails',
        'CREATE|201|/developers/([^/]+)/$|devs created|resolveDeveloperName',
        'DELETE|200|/developers/([^/]+)$|devs deleted|resolveDeveloperName',
        'UPDATE|200|/developers/([^/]+)$|developers updated|resolveDeveloperName',
        'CREATE|204|/developers/([^/]+)\\?action=active$|devs activated|resolveDeveloperName',
        'DELETE|200|/e/([^/]+)/apis/([^/]+)/revisions/([0-9]+)/deployments$|proxies undeployed|resolveApiProxyRevision',
        'DELETE|200|/apis/([^/]+)/revisions/([0-9]+)$|proxy revisions deleted|resolveApiProxyRevision2',
        'CREATE|200|/e/([^/]+)/apis/([^/]+)/revisions/([0-9]+)/deployments$|proxies deployed|resolveApiProxyRevision',
        'CREATE|201|/apis/([^/]+)/\\?action=import&name=([^&/]+)$|proxies imported|resolveProxyName',
        'UPDATE|200|/apis/([^/]+)/revisions/([0-9]+)\\?validate=true$|proxies updated|resolveProxyName',
        'DELETE|200|/apis/([^/]+)$|APIs deleted|resolveProxyName',
        'CREATE|201|/apiproducts/([^/]+)/$|api products created|resolveApiProduct',
        'UPDATE|200|/apiproducts/([^/]+)$|api products updated|resolveApiProduct',
        'DELETE|200|/apiproducts/([^/]+)$|api products deleted|resolveApiProduct',
        'CREATE|201|/reports/([^/]+)/$|AX reports created|resolveReportName',
        'UPDATE|200|/reports/([^/]+)$|AX reports updated|resolveReportName',
        'DELETE|200|/reports/([^/]+)$|AX reports deleted|resolveDeletedReportName',
        'CREATE|201|/environments/([^/]+)/apis/([^/]+)/revisions/([0-9]+)/debugsessions/([0-9]+)/\\?|Trace sessions created|resolveTraceSession',
        'DELETE|200|/environments/([^/]+)/apis/([^/]+)/revisions/([0-9]+)/debugsessions/([0-9]+)$|Trace sessions deleted|resolveTraceSession'
      ];

  context.elaborations = '';
  var promise = Promise.resolve(context);
  checks.forEach(function(check){
    var parts = check.split('|');
    var fkey = parts[4];
    log.write(8, sprintf('check(%s) fn:%s', parts[3], fkey));
    var re = new RegExp(s1 + parts[2]);
    var arr = [];
    var found = context.filteredAlerts.filter(function(alert){
          if (alert.operation != parts[0]) return false;
          if (alert.responseCode != parts[1]) return false;
          var m = alert.requestUri.match(re);
          if (!m) return false; // this alert is not this check
          if (fkey) {
            // the calls to get details must all be asynchronous
            arr.push({alert:alert, match:m});
          }
          return true;
        });

    if (found && found.length > 0) {
      promise = promise.then(function(c){
        c.elaborations += found.length + ' ' + simplePluralize(found.length, parts[3]) + '\n';
        return c;
      });

      // get detail if any
      if (arr.length>0) {
        arr.forEach(function (item) {
          promise = promise
            .then(function(c){c.match = item.match; c.alert = item.alert; return c;})
            .then(resolveFns[fkey]);
        });
      }
    }
  });
  return promise;
}


function fillMessageTemplate(template, message) {
  if (gConfig.alert.type == 'slack') { return message; }
  var newObject = copyHash(template);
  Object.keys(newObject).forEach(function(key){
    if (typeof newObject[key] == 'string') {
      newObject[key] = newObject[key].replace('%message%', message);
    }
  });
  return newObject;
}

function fireWebhooks(context) {
  // do not send alerts the first time through, or when the query failed
  if ( !gStatus.times.lastCheck || context.requestStatus != 200) {
    return context;
  }

  if (context.alertable.length === 0) {
    log.write(3,'fireWebhooks - no alerts');
    return context;
  }

  return Promise.resolve(context)
    .then(produceMessage)
    .then(function(context) {
      return new Promise( (resolve, reject) => {
        var postBody = fillMessageTemplate(gConfig.alert.template, context.message);
        var options = {
              timeout : 66000, // in ms
              uri: gConfig.alert.uri,
              method: 'post',
              body : JSON.stringify( postBody ),
              headers: {
                'content-type' : 'application/json',
                accept : 'application/json',
                'user-agent' : 'audit-watcher-1'
              }
            };

        if (gConfig.alert.token) {
          options.headers.authorization = 'Bearer ' + gConfig.alert.token;
        }

        request(options, function(e, httpResp, body) {
          if (e) {
            log.write(2, 'webhook call failed: ' + e);
          }
          gStatus.alertCounts.total++;
          return resolve(context);
        });

      });
    });
}

function getApigeeAuthn(ctx) {
  if ( ! gConfig.auth) {
    console.log('no authentication provided in config.json; exiting.');
    process.exit(1);
  }

  if (gConfig.auth.netrc) {
    let authUrl = require('url').parse(apiBase),
        rc = netrc();

    if ( ! rc[authUrl.hostname]) {
      console.log(`there is no entry for the management server (${apiBase}) in in the .netrc file.`);
      process.exit(2);
    }
    gConfig.auth.username = rc[authUrl.hostname].login;
    gConfig.auth.password = rc[authUrl.hostname].password;
    // let authzHeader = "Basic " + new Buffer(username + ":" + password)
    //     .toString("base64");
    return ctx;
  }

  console.log(`No way to authenticate to Apigee. Exiting.`);
  process.exit(3);
}


function getAudits(ctx) {
  // eg,
  // curl -i -n "https://api.enterprise.apigee.com/v1/audits/organizations/cap250?endTime=1449105607514&expand=true&startTime=1446513607514"

  return setApigeeAuthHeader(ctx)
    .then(() => new Promise( (resolve, reject) => {
      let now = (new Date()).valueOf(),
          query = {
            expand : true,
            startTime : now - lookbackInterval,
            endTime : now
          },
          options = {
            timeout : 66000, // in ms
            uri: auditBase + gConfig.organization + '?' + qs.stringify(query),
            method: 'get',
            headers: {
              'authorization' : gConfig.auth.authzHeader,
              'accept' : 'application/json',
              'user-agent' : 'audit-watcher-1'
            }
          };

      request(options, function(e, httpResp, body) {
        if (e) {
          log.write(2,'getAudits: error: ' + e);
          return reject(e);
        }

        if (httpResp.statusCode == 200) {
          var type = getType(body);
          if (type === "[object String]" && body.trim() !== '') {
            //console.log(body);
            try {
              body = JSON.parse(body);
              ctx.records = body.auditRecord;
              log.write(2, 'got %d records', ctx.records.length);
              gStatus.times.currentCheck = new Date(now);
            }
            catch(exc1) {
              log.write(2,'getAudits: cannot parse body: ' + exc1);
              if (getType(body) == "[object String]") {
                console.log('body: \n' +body);
              }
            }
          }
          else {
            log.write(8,'getAudits: no body');
          }
        }
        else {
          log.write(8,'getAudits: request ' + options.uri);
          log.write(8,'getAudits: status ' + httpResp.statusCode);
        }
        log.write(8,'getAudits: done');
        ctx.requestStatus = httpResp.statusCode;
        return resolve(ctx);
      });
    }));

}


function filterNewResults(context) {
  var alertable = [];
  if (context.requestStatus == 200) {
    var currentAuditRecords = context.records;
    // eg,
    // {
    //   "auditRecord" : [ {
    //     "operation" : "DELETE",
    //     "requestUri" : "/v1/organizations/cap250/apis/jn_Open_Weather",
    //     "responseCode" : "200",
    //     "timeStamp" : 1449105541324,
    //     "user" : "DChiesa@apigee.com"
    //   }, {
    //     "operation" : "DELETE",
    //     "requestUri" : "/v1/organizations/cap250/e/test/apis/jn_Open_Weather/revisions/5/deployments",
    //     "responseCode" : "200",
    //     "timeStamp" : 1449105540108,
    //     "user" : "DChiesa@apigee.com"
    //   }, {
    //     "operation" : "DELETE",
    //     "requestUri" : "/v1/organizations/cap250/apis/jcb_open_weather",
    //     "responseCode" : "400",
    //     "timeStamp" : 1449105527429,
    //     "user" : "DChiesa@apigee.com"
    //   },
    // ...

    if (currentAuditRecords) {
      if (previousAuditRecords) {
        var times = previousAuditRecords
          .map(function(item){return item.timeStamp;})
          .sort();
        times.reverse();
        var latestPrior = times[0];

        currentAuditRecords.forEach(function(r){
          var isNew = (r.timeStamp > latestPrior);
          if (isNew) {
            alertable.push(r);
          }
        });
      }
      else {
        alertable = currentAuditRecords;
      }

    }
  }
  context.alertable = alertable;
  //console.log(JSON.stringify(alertable,null,2)+'\n');
  return context;
}


function startCycle() {
    Promise.resolve({})
      .then(getApigeeAuthn)
      .then(getAudits)
      .then(filterNewResults)
      .then(fireWebhooks)
      .then(setWakeup)
      .catch( e => {
        log.write(1,'unhandled error: ' + e);
        log.write(1, e.stack);
      });
}

function setWakeup(context) {
  var now = new Date();
  if ( ! gConfig.sleepTime) {
    gConfig.sleepTime = 600000;
    let phrase = timeResolver.timeIntervalToPhrase(gConfig.sleepTime);
    log.write(2, `defaulting to sleep time of ${phrase}`);
  }
  else {
    let phrase = timeResolver.timeIntervalToPhrase(gConfig.sleepTime);
    log.write(2, `sleeping ${phrase}`);
  }
  let sleeptime = timeResolver.timeIntervalToMilliseconds(gConfig.sleepTime);

  let wakeTime = new Date(now.valueOf() + sleeptime);
  log.write(2, 'wake at ' + moment(wakeTime).tz(gTz).format().substring(11,19));

  // swap times
  gStatus.times.lastCheck = gStatus.times.currentCheck;
  delete gStatus.times.currentCheck;

  gStatus.times.lastStatus = gStatus.times.currentStatus;
  delete gStatus.times.currentStatus;

  gStatus.times.wake = moment(wakeTime).tz('GMT').format();
  // save the old list of records
  previousAuditRecords = context.records;

  // now, sleep. on wakeup, will run again.
  setTimeout(startCycle, sleeptime);

  // return synchronously
  return context;
}



// ================================================================
// Server interface

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/status', function(request, response) {
  response.header('Content-Type', 'application/json');
  gStatus.times.current = moment().tz('GMT').format();
  gStatus.nRequests++;

    response.status(200)
      .send(JSON.stringify(gStatus, null, 2) + "\n");
});


// default behavior
app.all(/^\/.*/, function(request, response) {
  response.header('Content-Type', 'application/json')
    .status(404)
    .send('{ "message" : "This is not the server you\'re looking for." }\n');
});


let port = process.env.PORT || 5950;
app.listen(port, function() {
  log.write(0, `audit watcher version ${gStatus.version}`);
  log.write(0, `listening on port ${port}`);
  log.write(0, `log level is: ${gStatus.loglevel}`);
  gConfig = JSON.parse(fs.readFileSync(path.join('config', 'config.json'), 'utf8'));
  gTz = gConfig.timezone || 'America/Los_Angeles';
  setTimeout(startCycle, 1);
});
