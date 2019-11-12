# Apigee Audit Watcher in nodejs

This is a nodejs program that polls the Apigee audit trail, and
then invokes webhooks with notification of changes.

Today the outbound connections include: slack, google chat, and hipchat.

Possible extensions include: Microsoft Teams, Splunk log, other logging systems.

## License

This code is Copyright (c) 2019 Google LLC, and is released under the Apache Source License v2.0. For information see the [LICENSE](LICENSE) file.

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
  "alert" : {
    ...
  }
}
```

Most of that data is self-explanatory. For `auth`, you have some options:

Option 1: retrieve credentials from .netrc:

```
  "auth" : {
    "netrc" : true
  }
```

This tells the program to look in the ~/.netrc file for credentials for
api.enterprise.apigee.com , and use _those_ credentials to authenticate to
Apigee.

Option 2: directly store the credentials in the config.json file:


```
  "auth" : {
    "username" : "myuser@example.com",
    "password" : "Secret123"
  }
```

For the `alert` you have several options: slack, googlechat, or hipchat.

To set up slack, you need to visit the [webhooks
page](https://api.slack.com/messaging/webhooks), create an App, enable it as an
incoming webhook, and copy the resulting URL.

Then use this as the alert:
```
  "alert" : {
    "type" : "slack",
    "uri" : "https://hooks.slack.com/services/LOCATION/DEPENDENT/PATH"
  }
```

To set up googlechat, follow the
[example](./config/example-config-googlechat.json).
Likewise, for hipchat, follow the
[example](./config/example-config-hipchat.json).


The complete configuration file, with the `auth` and `alert` fields, might look like this:

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


## Bugs

* the tool can watch only a single organization
* there is no good way to provide credentials beyond using .netrc
