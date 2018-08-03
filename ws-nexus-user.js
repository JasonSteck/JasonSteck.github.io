window.WSNexusUser = window.Nexus = (function() {
const apiVersion = '1.0.0';

// Experiment with morphing the current instance.
const NexusTypes = {
Dead: () => ({}),
Client: function() { return {
  host: null,
  onMessage: createAwaitableEvent(this._missedEvent('<Client>.onMessage.then')),
  send(message) {
    this.whenJoined.then(()=>{
      this._ws.send(JSON.stringify({
        type: 'SEND',
        message,
      }));
    });
  },
  _onServerMessage(json) {
    switch(json.type) {
      case 'JOINED':
        this.host = json.host;
        this.whenJoined.success(this.host);
        break;
      case 'NO_SUCH_HOST':
        this._changeType('User');
        this.whenJoined.failure(new Error('Cannot connect to host'));
        break;
      case 'MESSAGE':
        this.onMessage.trigger(json.message);
        break;
      default:
        this.default._onServerMessage.bind(this)(json);
    }
  }
}},

Host: function() { return {
  id: null,
  name: null,
  clientIDs: [],
  onNewClient: createAwaitableEvent(this._missedEvent('<Host>.onNewClient.then')),
  onLostClient: createAwaitableEvent(this._missedEvent('<Host>.onLostClient.then')),
  onMessage: createAwaitableEvent(this._missedEvent('<Host>.onMessage.then')),
  send(message, clientIDs) {
    this._ws.send(JSON.stringify({
      type: 'SEND',
      message,
      clientIDs,
    }));
  },
  _onServerMessage(json) {
    switch(json.type) {
      case 'HOSTING':
        this.id = json.id;
        this.name = json.name;
        this.whenHosting.success(json);
        break;
      case 'NEW_CLIENT':
        this.clientIDs.push(json.clientID);
        this.onNewClient.trigger(json.clientID, json.request);
        break;
      case 'LOST_CLIENT':
        const index = this.clientIDs.indexOf(json.clientID);
        this.clientIDs = [
          ...this.clientIDs.slice(0, index),
          ...this.clientIDs.slice(index + 1),
        ];
        this.onLostClient.trigger(json.clientID);
        break;
      case 'FROM_CLIENT':
        this.onMessage.trigger(json.message, json.clientID);
        break;
      default:
        this.default._onServerMessage.bind(this)(json);
    }
  }
}},

User: () => ({
  host(hostType) {
    let req = hostTypeObject(hostType);
    req.type = 'HOST';

    this.whenServerConnected.then(()=>{
      this._ws.send(JSON.stringify(req));
    }).onError(()=>{
      // when we lose server connection, switch to Dead mode
      this._changeType('Dead');
    });
    this._changeType('Host');
    this._setThen(this.whenHosting);
    return this;
  },
  join(hostType) {
    let req = hostTypeObject(hostType);
    req.type = 'JOIN';

    this.whenServerConnected.then(()=>{
      this._ws.send(JSON.stringify(req));
    }).onError(()=>{
      // when we lose server connection, switch to Dead mode
      this._changeType('Dead');
    });
    this._changeType('Client');
    this._setThen(this.whenJoined);
    return this;
  },
  joinOrHost(hostType) {
    this.join(hostType).onError(() => this.host(hostType));
    return this;
  }
})};

class NexusBase {
  constructor(nexusServerAddress) {
    this._type = null;
    this.nexusServerAddress = nexusServerAddress;
    this.default = this.__proto__;
    this.ignoreWarnings = false;
    this.apiVersion = apiVersion;

    this.whenServerConnected = createAwaitableState(
      this._missedEvent('.whenServerConnected.then'),
      this._missedEvent('.whenServerConnected.onError'),
    );
    this.whenHosting = createAwaitableState( // when we have registered as a host
      this._missedEvent('.whenHosting.then'),
      this._missedEvent('.whenHosting.onError'),
    );
    this.whenJoined = createAwaitableState( // when we have joined a host
      this._missedEvent('.whenJoined.then'),
      this._missedEvent('.whenJoined.onError'),
    );

    this.onClose = createAwaitableEvent(this._missedEvent('.onClose.then'));
    this.onList = createAwaitableEvent(this._missedEvent('.onList.then'));
    this.onServerInfo = createAwaitableEvent(this._missedEvent('.onServerInfo.then'));
    this.onServerInfo(json => { // event is always silent since we have this
      if(json.apiVersion !== this.apiVersion) {
        const server = json.apiVersion.split('.');
        const self = this.apiVersion.split('.');

        if(server[0] !== self[0]) { // major version is different
          console.error("WSNexusUser Error: Core api features may not work. Your api version (%s) does not match the server's api version (%s)", this.apiVersion, json.apiVersion);
        } else if(server[1] !== self[1]) { // minor version is different
          console.warn("WSNexusUser Warning: Optional api features may not work. Your api version (%s) does not match the server's api version (%s)", this.apiVersion, json.apiVersion);
        }
        // (ignore patch versions)
      }
    });

    this._ws = new WebSocket(nexusServerAddress);
    this._ws.onmessage = e => {
      this._log('* ServerMessage:', e.data);
      const json = JSON.parse(e.data);
      this._onServerMessage(json);
    };
    this._ws.onopen = this.whenServerConnected.success;
    this._ws.onerror = () => {
      const error = new Error('Server connection failed');
      this.whenServerConnected.failure(error);
    };
    this._ws.onclose = ({ code, reason }) => this.onClose.trigger(reason, code);

    this._setThen(this.whenServerConnected);
    this._changeType('User');
  }

  get type() {
    return this._type;
  }

  getHosts() {
    this._awaitable.then(()=>this._ws.send('{"type":"LIST"}'));
    return this.onList;
  }

  close(reason="You closed your connection", code=1000) {
    this._awaitable.then(()=>{
      this.onClose.then(()=>{}); // ensure we hide onClose default warnings
      this._ws.close(code, reason);
    });
    return this.onClose;
  }

  _onServerMessage(json) {
    switch(json.type) {
      case 'LIST':
        this.onList.trigger(json.payload);
        break;
      case 'SERVER_INFO':
        this.onServerInfo.trigger(json);
        break;
      default:
        console.log('(Unhandled server message:', json);
    }
  }

  _missedEvent(eventName) {
    return (...payload) => {
      if(!this.ignoreWarnings && !Nexus.ignoreWarnings) {
        console.warn('Unhandled awaitableEvent "%s":', eventName, ...payload);
      }
    }
  }

  _log(...args) {
    if(this.debug || Nexus.debug) {
      console.log(...args);
    }
  }

  // Allow .then/await to be used on an instance of this class
  _setThen(awaitable) {
    this._awaitable = awaitable;
    this.then = (resolved) => {
      const doResolve = ()=>{
        this.then = undefined; // prevent infinite cycle when awaiting this thenable object that returns this same object
        resolved(this);
      };

      awaitable.then(doResolve);
      return this;
    }

    this.onError = (rejected) => {
      const doReject = ()=>{
        this.then = undefined; // prevent infinite cycle when awaiting this thenable object that returns this same object
        rejected(this);
      };

      awaitable.onError(doReject);
      return this;
    }
  }

  // Modifies the properties on this object to make it a different "type"
  _changeType(to) {
    removeType(this, this.type);
    addType(this, to);
  }
}

// ========================================= Helpers ========================================= //

function removeType(obj, typeName) {
  if(typeName) {
    if(obj._type !== typeName) {
      throw new Error(`Cannot remove type "${typeName}" when object has type "${obj._type}"`);
    }
    if(!(typeName in NexusTypes)) {
      throw new Error('Invalid typeName when removing type:', typeName);
    }
    obj._typeProps.forEach(prop => delete obj[prop]);
    delete obj._typeProps;
    obj._type = null;
  } else if(typeName === undefined) {
    throw new Error('Cannot remove type on object with undefined type (double check the correct object is passed and it has `._type` set as null or a valid type)');
  }
}

function addType(obj, typeName) {
  if(!(typeName in NexusTypes)) {
    throw new Error('Invalid typeName when adding type:', typeName);
  }

  const type = NexusTypes[typeName];
  const props = type.call(obj);
  Object.assign(obj, props);
  obj._typeProps = Object.keys(props);
  obj._type = typeName;
}

function createAwaitableEvent(defaultCallback) {
  let anyNonce = false;
  let listeners = [];

  function awaitableEvent(callback) {
    if(typeof callback !== 'function') throw new Error('Callbacks must be functions');

    listeners.push(callback);
    return awaitableEvent;
  }

  awaitableEvent.then = function(callback) {
    if(typeof callback !== 'function') throw new Error('Callbacks must be functions');

    anyNonce = true;
    callback._PromiseEventNonce = true;
    listeners.push(callback);
    return awaitableEvent;
  }

  awaitableEvent.trigger = function(...args) {
    const current = listeners;
    if(current.length === 0) {
      defaultCallback && defaultCallback(...args);
      return;
    }
    if(anyNonce) {
      // Remove one-time listeners
      listeners = listeners.filter(l => {
        if(!l._PromiseEventNonce) return true;
        delete l._PromiseEventNonce;
      });
      anyNonce = false;
    }
    current.forEach(callback => callback(...args));
  }
  return awaitableEvent;
}

function createAwaitableState(defaultThenCallback, defaultElseCallback) {
  let goodState;
  let badState;

  let thenListeners = createAwaitableEvent(defaultThenCallback);
  let elseListeners = createAwaitableEvent(defaultElseCallback);

  function awaitableState(resolved, rejected) {
    if(resolved) thenListeners(resolved);
    if(rejected) elseListeners(rejected);

    if(goodState) {
      resolved(...goodState);
    } else if(badState) {
      rejected(...badState);
    }

    return awaitableState;
  }

  awaitableState.then = function(callback) {
    if(goodState) {
      callback(...goodState);
    } else {
      thenListeners.then(callback);
    }
    return awaitableState;
  }

  awaitableState.onError = function(callback) {
    if(badState) {
      callback(...badState);
    } else {
      elseListeners.then(callback);
    }
    return awaitableState;
  }

  awaitableState.success = function(...args) {
    goodState = args;
    badState = null;

    thenListeners.trigger(...args);
  }

  awaitableState.failure = function(...args) {
    goodState = null;
    badState = args;

    elseListeners.trigger(...args);
  }

  return awaitableState;
}

function hostTypeObject(hostType) {
  let obj;
  switch(typeof hostType) {
    case 'string':
      obj = { name: hostType };
      break;
    case 'number':
      obj = { id: hostType };
      break;
    case 'object':
      obj = hostType;
      break;
    default:
      throw new Error('Invalid hostType:', hostType);
  }
  return obj;
}

window.NexusBase = NexusBase;

const Nexus = (serverAddress='ws://127.0.0.1:3000') => new NexusBase(serverAddress);
return Nexus;

})();
