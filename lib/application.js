var async         = require('async');
var stream        = require('stream');
var util          = require('util');
var net           = require('net');
var merge         = require('merge');
var through       = require('through');
var hat           = require('hat');
var es            = require('event-stream');
var konduit       = require('konduit');
var enableDestroy = require('server-destroy');

// default options
var DEFAULTS = {
  minPeers: 3,
  maxPeers: 12,
  seeds: [],
  logger: console
};

function Application(options) {
  var self = this;

  stream.Duplex.call(self, { objectMode: true });

  self.id          = hat();
  self.server      = net.createServer(self._handleInbound.bind(self));
  self.options     = merge(Object.create(DEFAULTS), options);
  self.connections = { inbound: [], outbound: [] };

  enableDestroy(self.server);

  // setup middlware stack with initial entry a simple passthrough
  self.stack = [function(socket) {
    return through(function(data) { this.queue(data) });
  }];

  // setup logger
  Object.defineProperty(self, 'log', {
    value: this.options.logger || {
      info: NOOP, warn: NOOP, error: NOOP
    }
  });

  // connect to seeds
  self._enterNetwork()
  setInterval(function() { self._enterNetwork() }, 5000);
};

util.inherits(Application, stream.Duplex);

Application.prototype.use = function(middleware) {
  var self  = this;

  if (!Array.isArray(middleware)) middleware = [middleware];

  middleware.forEach(function(ware) {
    if (typeof ware !== 'function') {
      throw new TypeError('Middleware must be a function');
    }

    // is there a _plugin() ?
    if (typeof ware._plugin === 'function') ware._plugin(self);

    // register the tranform stream in the stack
    self.stack.push(ware);
  });

  return self;
};

Application.prototype.set = function(key, value) {
  return this.options[key] = value;
};

Application.prototype.get = function(key) {
  return this.options[key] || null;
};

Application.prototype.listen = function() {
  var args = Array.prototype.slice.call(arguments);

  this.log.info('Starting server on port ' + args[0]);

  return this.server.listen.apply(this.server, args);
};

Application.prototype.connect = function() {
  var self   = this;
  var args   = Array.prototype.slice.call(arguments);
  var socket = net.connect.apply(this, args);

  self.log.info('Opening connection to peer');

  // track in outbound connections
  self.connections.outbound.push(socket);

  // fire all middleware _connect() implementations
  socket.on('connect', function() {
    self._process(socket);
    self.emit('peerConnected', socket.address());
  });

  // cleanup after losing outbound connection
  socket.on('end', function() {
    self._cleanup(socket);
    self.emit('peerDisconnected', socket.address());
  });

  return socket;
};

Application.prototype.peers = function(iterator) {
  var handles   = [];
  var addresses = [];
  var inbound   = this.connections.inbound;
  var outbound  = this.connections.outbound;
  var everyone  = [].concat(inbound).concat(outbound).filter(function(sock) {
    if (sock._handle) {
      var fdesc = sock._handle.fd;

      if (handles.indexOf(url) !== -1) {
        return false;
      }

      handles.push(fdesc);
    }

    if (sock.address()) {
      var url = sock.address().address + ':' + sock.address().port;

      if (addresses.indexOf(url) !== -1) {
        return false;
      }

      addresses.push(url);
    }

    return true;
  });

  if (typeof iterator === 'function') everyone.forEach(iterator);

  return everyone;
};

Application.prototype._enterNetwork = function() {
  var self   = this;
  var active = self.connections.outbound.filter(function(c) {
    return !c._connecting;
  });

  if (self.options.maxPeers <= active.length) return; // we have enough active seeds
  if (self.options.minPeers <= active.length) return; // we have enough active seeds

  self.options.seeds.forEach(function(seed) {
    var host = seed.split(':')[0];
    var port = seed.split(':')[1];

    for (var a = 0; a < active.length; a++) {
      var remoteAddr = active[a].remoteAddress;
      var remotePort = active[a].remotePort;

      if (host === 'localhost' || remoteAddr === '127.0.0.1') return;
      if (host === remoteAddr && port === remotePort) return;
    }

    var socket = self.connect(port, host);

    socket.on('error', function(err) {
      self._cleanup(socket);
      self.log.error('Failed to connect to peer', err.message);
    });
  });
};

Application.prototype._process = function(socket) {
  var self  = this;
  var stack = self._initMiddlewareStack(socket);

  self.log.info('Processing socket ', socket.address());

  socket.pipe(stack[0]);

  return stack[stack.length - 1];
};

Application.prototype._initMiddlewareStack = function(socket) {
  var self = this

  // create a pipeline
  var pipeline = konduit.createPipeline({ log: self.logger });

  // instantiate new stack
  var stack = self.stack.map(function(wareFn, index) {
    return wareFn(socket);
  });

  stack.forEach(function(ware, index) {
    pipeline.use(ware);

    if (typeof ware._init === 'function') {
      ware._init(self, socket);
    }

    return ware;
  });

  pipeline.open().on('data', function(d) { self.push(d) });

  return stack;
};

Application.prototype._cleanup = function(socket) {
  [
    this.connections.inbound,
    this.connections.outbound
  ].forEach(function(list) {
    list.forEach(function(sock, i) {
      if (sock === socket) {
        list.splice(i, 1);
      }
    });
  });
};

Application.prototype._read = function() {
  // noop
};

Application.prototype._write = function(chunk, encoding, callback) {
  var self = this;
  // send outgoing messages
  self.peers(function(p) {
    if (Buffer.isBuffer(chunk)) {
      return p.write(chunk.toString());
    }
    else if (typeof chunk === 'string') {
      return p.write(chunk);
    }
    else {
      try {
        return p.write(JSON.stringify(chunk));
      }
      catch(err) {
        self.log.error(err);
      }
    }
  });

  callback();
};

Application.prototype._handleInbound = function(socket) {
  var self   = this;
  var addr   = socket.address();
  var remote = addr ? addr.address + ':' + addr.port : '?';

  // handle incoming connection sockets
  self.log.info('Handling inbound connection from ' + remote);

  // cleanup after losing inbound connection
  socket.on('end', function() {
    self._cleanup(socket);
    self.emit('peerDisconnected', socket.address());
  });

  self.connections.inbound.push(socket);

  self._process(socket);
  self.emit('peerConnected', socket.address());
};

function NOOP() {};

module.exports = Application;
