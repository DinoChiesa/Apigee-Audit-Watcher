# Apigee Audit Watcher in nodejs

This is a nodejs program that polls the Apigee audit trail, and
then invokes webhooks with notification of changes.

Today the outbound connections include: Slack, Google Chat, and Hipchat.

For example, an alert to slack looks like this:

![screengrab](images/screenshot-20191112-154519.png)


Possible extensions include: Microsoft Teams, Splunk log, other logging systems.

## License

This code is Copyright (c) 2019-2020 Google LLC, and is released under the
Apache Source License v2.0. For information see the [LICENSE](LICENSE) file.

## Disclaimer

This tool is not an official Google product, nor is it part of an official Google product.

## Running the program

This program depends on node v10 or greater, and npm v6 or greater.
Make sure you have those things installed.

Then, running the program is as easy as 1,2,3:

1. install pre-requisites

2. fill in the config/config.json file

3. invoke the program


More details below.

## 1. Install pre-requisites

This is a one-time thing. After you clone the repo, just install like this:

```
npm install
```

## 2. Provide the Configuration

Provide a file in the config directory named `config.json`.
This file tells the program:

* which Apigee organization to watch
* how often to check the audit trail for updates (typically 10 minutes)
* where to post notification of any observed updates

The contents should be like this:
```json
{
  "organization": "my-org-name",
  "auth" : {
    ...
  },
  "timezone": "America/Los_Angeles",
  "sleepTime" : "10m",
  "loglevel" : 3,
  "alert" : {
    ...
  }
}
```

Some of those fields are self-explanatory.

The `timezone` is optional. It is the zone in which times will be expressed, in outbound
notifications, to Slack and so on. If you leave it blank, it will default to US
West-coast time ("America/Los_Angeles").

For `auth`, you have some options:

1. retrieve credentials from .netrc:

   ```
     "auth" : {
       "netrc" : true
     },
   ```

   This tells the program to look in the ~/.netrc file for credentials for
   api.enterprise.apigee.com , and use _those_ credentials to authenticate to
   Apigee.

2. directly store the credentials in the config.json file:

  ```
    "auth" : {
      "username" : "myuser@example.com",
      "password" : "Secret123"
    },
  ```

For the `alert` you have several options: `slack`, `googlechat`, or `hipchat`.

To set up slack, you need to visit the [webhooks
page](https://api.slack.com/messaging/webhooks), create an App, enable it as an
incoming webhook, and copy the resulting URL.

Then use this as the alert:
```
  "alert" : {
    "type" : "slack",
    "uri" : "https://hooks.slack.com/services/LOCATION/DEPENDENT/PATH"
  },
```

To set up googlechat, follow the
[example](./config/example-config-googlechat.json).
Likewise, for hipchat, follow the
[example](./config/example-config-hipchat.json).


A complete configuration file, with the required `auth` and `alert` fields, might look like this:

```json
{
  "organization": "my-org-name",
  "auth" : {
    "netrc": true
  },
  "timezone": "America/Los_Angeles",
  "sleepTime" : "10m",
  "alert" : {
    "type" : "slack",
    "uri" : "https://hooks.slack.com/services/LOCATION/DEPENDENT/PATH"
  }
}
```


## 3. Run the program

```
npm run watch
```

## Logging

By default, the program will log its operations. You can increase or decrease
the level of logging with the `loglevel` setting in the config.json file. 

The output at loglevel=3 looks like this:

```
$ npm run watch

> audit-watcher@1.0.1 watch /Users/dchiesa/dev/node/apigee-audit-watcher
> node ./auditWatcher.js

[2019-Nov-12 15:27:48] audit watcher version 20191112-0944
[2019-Nov-12 15:27:48] listening on port 5950
[2019-Nov-12 15:27:48] log level is: 3
[2019-Nov-12 15:27:48] POST https://login.apigee.com/oauth/token
[2019-Nov-12 15:27:49] ==> 200
[2019-Nov-12 15:27:49] GET https://api.enterprise.apigee.com/v1/audits/organizations/gaccelerate3?expand=true&startTime=1573565269799&endTime=1573601269799
[2019-Nov-12 15:27:53] ==> 200
[2019-Nov-12 15:27:53] got 4 records
[2019-Nov-12 15:27:53] sleeping 1 minute
[2019-Nov-12 15:27:53] wake at 15:28:53
[2019-Nov-12 15:28:53] GET https://api.enterprise.apigee.com/v1/audits/organizations/gaccelerate3?expand=true&startTime=1573565333079&endTime=1573601333079
[2019-Nov-12 15:28:55] ==> 200
[2019-Nov-12 15:28:55] got 4 records
[2019-Nov-12 15:28:55] fireWebhooks - no alerts
[2019-Nov-12 15:28:55] sleeping 1 minute
[2019-Nov-12 15:28:55] wake at 15:29:55
...
```

## Bugs

* The tool can watch only a single organization

* There is no good way to provide credentials beyond using .netrc. A good way to
  solve this is to run this as an appengine app and use a service-account with
  implicit access to the Apigee org, but that works only in Apigee ng SaaS or Apigee
  hybrid.
