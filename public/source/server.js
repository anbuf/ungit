
var signals = require('signals');
var programEvents = require('ungit-program-events');
var _ = require('lodash');

function Server() {
}
module.exports = Server;

Server.prototype.initSocket = function() {
  var self = this;
  this.socket = io.connect();
  this.socket.on('error', function(err) {
    self._isConnected(function(connected) {
      if (connected) throw err;
      else self._onDisconnect();
    });
  });
  this.socket.on('disconnect', function() {
    self._onDisconnect();
  });
  this.socket.on('connected', function (data) {
    self.socketId = data.socketId;
    programEvents.dispatch({ event: 'connected' });
  });
  this.socket.on('working-tree-changed', function () {
    programEvents.dispatch({ event: 'working-tree-changed' });
  });
  this.socket.on('git-directory-changed', function () {
    programEvents.dispatch({ event: 'git-directory-changed' });
  });
  this.socket.on('request-credentials', function () {
    self._getCredentials(function(credentials) {
      self.socket.emit('credentials', credentials);
    });
  });
}
Server.prototype._queryToString = function(query) {
  var str = [];
  for(var p in query)
    if (query.hasOwnProperty(p)) {
      str.push(encodeURIComponent(p) + "=" + encodeURIComponent(query[p]));
    }
  return str.join("&");
}
Server.prototype._httpJsonRequest = function(request, callback) {
  var httpRequest = new XMLHttpRequest();
  httpRequest.onreadystatechange = function() {
    if (httpRequest.readyState === 0) {
      callback({ error: 'connection-lost' });
    } else if (httpRequest.readyState === 4) {
      var body;
      try {
        body = JSON.parse(httpRequest.responseText);
      } catch(ex) { body = null; }
      if (httpRequest.status != 200) callback({ status: httpRequest.status, body: body, text: httpRequest.responseText });
      else callback(null, body);
    }
  }
  var url = request.url;
  if (request.query) {
    url += '?' + this._queryToString(request.query);
  }
  httpRequest.open(request.method, url, true);
  httpRequest.setRequestHeader('Accept', 'application/json');
  if (request.body) {
    httpRequest.setRequestHeader('Content-Type', 'application/json');
    httpRequest.send(JSON.stringify(request.body));
  } else {
    httpRequest.send(null);
  }
}
// Check if the server is still alive
Server.prototype._isConnected = function(callback) {
  this._httpJsonRequest({ method: 'GET', url: '/api/ping' }, function(err, res) {
    callback(!err && res && res.ok);
  });
}
Server.prototype._onDisconnect = function() {
  programEvents.dispatch({ event: 'disconnected' });
}
Server.prototype._getCredentials = function(callback) {
  // Push out a program event, hoping someone will respond! (Which the app component will)
  programEvents.dispatch({ event: 'request-credentials' });
  var credentialsBinding = programEvents.add(function(event) {
    if (event.event != 'request-credentials-response') return;
    credentialsBinding.detach();
    callback({ username: event.username, password: event.password });
  });
}
Server.prototype.watchRepository = function(repositoryPath, callback) {
  this.socket.emit('watch', { path: repositoryPath }, callback);
};

Server.prototype.get = function(path, query, callback) {
  this.query('GET', path, query, callback);
}
Server.prototype.post = function(path, body, callback) {
  this.query('POST', path, body, callback);
}
Server.prototype.del = function(path, query, callback) {
  this.query('DELETE', path, query, callback);
}
Server.prototype.query = function(method, path, body, callback) {
  var self = this;
  if (body) body.socketId = this.socketId;
  var request = {
    method: method,
    url: '/api' + path,
  }
  if (method == 'GET' || method == 'DELETE') request.query = body;
  else request.body = body;
  var precreatedError = new Error(); // Capture stack-trace
  this._httpJsonRequest(request, function(error, res) {
    if (error) {
      if (error.error == 'connection-lost') {
        self._isConnected(function(connected) {
          if (connected) callback({ errorCode: 'cross-domain-error', error: error });
          else self._onDisconnect();
        });
        return;
      }
      var errorSummary = 'unknown';
      if (error.body) {
        if (error.body.errorCode && error.body.errorCode != 'unknown') errorSummary = error.body.errorCode;
        else if (typeof(error.body.error) == 'string') errorSummary = error.body.error.split('\n')[0];
        else errorSummary = JSON.stringify(error.body.error);
      }
      else errorSummary = error.statusText + ' ' + error.status;

      var err = {
        errorSummary: errorSummary,
        error: error,
        path: path,
        res: error,
        errorCode: error && error.body ? error.body.errorCode : 'unknown'
      };
      if (callback && callback(err)) return;
      else self._onUnhandledBadBackendResponse(err, precreatedError);
    }
    else if (callback)
      callback(null, res);
  });
};

Server.prototype._skipReportErrorCodes = [
  'remote-timeout',
  'permision-denied-publickey',
  'no-supported-authentication-provided',
  'offline',
  'proxy-authentication-required',
  'no-remote-configured',
  'ssh-bad-file-number',
  'no-git-name-email-configured'
];
Server.prototype._backendErrorCodeToTip = {
  'remote-timeout': 'Repository remote timeouted.',
  'no-supported-authentication-provided': 'No supported authentication methods available. Try starting ssh-agent or pageant.',
  'offline': 'Couldn\'t reach remote repository, are you offline?',
  'proxy-authentication-required': 'Proxy error; proxy requires authentication.',
  'no-remote-configured': 'No remote to list refs from.',
  'ssh-bad-file-number': 'Got "Bad file number" error. This usually indicates that the port listed for the remote repository can\'t be reached.',
  'non-fast-forward': 'Couldn\'t push, things have changed on the server. Try fetching new nodes.',
  'no-git-name-email-configured': 'Git email and/or name not configured. You need to configure your git email and username to commit files.<br> Run <code>git config --global user.name "your name"</code> and <code>git config --global user.email "your@email.com"</code>'
};
Server.prototype._onUnhandledBadBackendResponse = function(err, precreatedError) {
  var self = this;
  // Show a error screen for git errors (so that people have a chance to debug them)
  if (err.res.body && err.res.body.isGitError) {

    // Skip report is used for "user errors"; i.e. it's something ungit can't really do anything about.
    // It's still shown in the ui but we don't send a bug report since we can't do anything about it anyways
    var shouldSkipReport = this._skipReportErrorCodes.indexOf(err.errorCode) >= 0;
    if (!shouldSkipReport) {
      if (ungit.config.bugtracking) {

        var extra = {
          stdout: err.res.body.stdout.slice(0, 100),
          stderr: err.res.body.stderr.slice(0, 100),
          path: err.path,
          summary: err.errorSummary,
          stacktrace: err.res.body.stackAtCall.slice(0, 300),
          lineNumber: err.res.body.lineAtCall,
          command: err.res.body.command
        }

        var name = 'GitError: ' + (err.res.body.stackAtCall || '').split('\n')[3] + err.errorSummary;

        Raven.captureException(name, { extra: extra, tags: { subsystem: 'git' } });
      }
      if (ungit.config.sendUsageStatistics) {
        Keen.addEvent('git-error', { version: ungit.version, userHash: ungit.userHash });
      }
      console.log('git-error', err); // Used by the clicktests
    }
    programEvents.dispatch({ event: 'git-error', data: {
      tip: self._backendErrorCodeToTip[err.errorCode],
      command: err.res.body.command,
      error: err.res.body.error,
      stdout: err.res.body.stdout,
      stderr: err.res.body.stderr,
      shouldSkipReport: shouldSkipReport,
      repoPath: err.res.body.workingDirectory
    } });
  }
  // Everything else is handled as a pure error, using the precreated error (to get a better stacktrace)
  else {
    precreatedError.message = 'Backend error: ' + err.errorSummary;
    console.error(err.errorSummary);
    console.log(precreatedError.stack);
    Raven.captureException(precreatedError);
    programEvents.dispatch({ event: 'git-crash-error' });
  }
}