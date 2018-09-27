const Promise = require('bluebird');

const readdirp = require('readdirp');
const util = require('util');
const async = require('async');
const _ = require('lodash');

const cql = Promise.promisifyAll(require('dse-driver'));
const ORM = Promise.promisifyAll(require('./orm/apollo'));
const debug = require('debug')('express-cassandra');

const CassandraClient = function f(options) {
  const self = this;
  self.modelInstance = {};
  self.orm = new ORM(options.clientOptions, options.ormOptions);
};

CassandraClient.createClient = (options) => (new CassandraClient(options));

CassandraClient.setDirectory = (directory) => {
  CassandraClient.directory = directory;
  return CassandraClient;
};

CassandraClient.bind = (options, cb) => {
  const self = CassandraClient;
  self.modelInstance = {};
  self.orm = new ORM(options.clientOptions, options.ormOptions);
  self.orm.connect((err) => {
    if (err) {
      if (cb) cb(err);
      return;
    }

    readdirp({
      root: self.directory,
      fileFilter: [
        '*.js', '*.javascript', '*.jsx', '*.coffee', '*.coffeescript', '*.iced',
        '*.script', '*.ts', '*.tsx', '*.typescript', '*.cjsx', '*.co', '*.json',
        '*.json5', '*.litcoffee', '*.liticed', '*.ls', '*.node', '*.toml', '*.wisp',
      ],
    }, (err1, list) => {
      if (err1 && err1.length > 0) {
        if (cb) cb(err1[0]);
        return;
      }

      list = list.files;

      async.each(list, (file, callback) => {
        if (file.name.indexOf('Model') === -1) {
          callback();
          return;
        }

        const modelName = self._translateFileNameToModelName(file.name);

        if (modelName) {
          const filePath = util.format('%s/%s', self.directory, file.path);
          // eslint-disable-next-line import/no-dynamic-require
          const modelSchema = require(filePath);
          self.modelInstance[modelName] = self.orm.add_model(
            modelName.toLowerCase(),
            modelSchema,
            (err2) => {
              if (err2) callback(err2);
              else callback();
            },
          );
          self.modelInstance[modelName] = Promise.promisifyAll(self.modelInstance[modelName]);
        } else {
          callback();
        }
      }, (err3) => {
        if (err3 && cb) {
          cb(err3);
        } else if (cb) {
          cb();
        }
      });
    });
  });
};

CassandraClient.bindAsync = Promise.promisify(CassandraClient.bind);

CassandraClient.prototype.connect = function f(callback) {
  const self = this;
  self.orm.connect(callback);
};

CassandraClient.prototype.connectAsync = Promise.promisify(CassandraClient.prototype.connect);

CassandraClient.prototype.loadSchema = function f(modelName, modelSchema, callback) {
  const self = this;
  const cb = function cb(err) {
    if (typeof callback === 'function') {
      if (err) callback(err);
      else callback(null, self.modelInstance[modelName]);
    }
  };
  self.modelInstance[modelName] = self.orm.add_model(modelName, modelSchema, cb);
  self.modelInstance[modelName] = Promise.promisifyAll(self.modelInstance[modelName]);
  return self.modelInstance[modelName];
};

CassandraClient.prototype.loadSchemaAsync = function f(modelName, modelSchema) {
  return new Promise((resolve, reject) => {
    this.loadSchema(modelName, modelSchema, (err, Model) => {
      if (err) reject(err);
      else resolve(Model);
    });
  });
};

CassandraClient.uuid = () => (cql.types.Uuid.random());

CassandraClient.uuidFromString = (str) => (cql.types.Uuid.fromString(str));

CassandraClient.uuidFromBuffer = (buf) => (new cql.types.Uuid(buf));

CassandraClient.timeuuid = () => (cql.types.TimeUuid.now());

CassandraClient.timeuuidFromDate = (date) => (cql.types.TimeUuid.fromDate(date));

CassandraClient.timeuuidFromString = (str) => (cql.types.TimeUuid.fromString(str));

CassandraClient.timeuuidFromBuffer = (buf) => (new cql.types.TimeUuid(buf));

CassandraClient.maxTimeuuid = (date) => (cql.types.TimeUuid.max(date));

CassandraClient.minTimeuuid = (date) => (cql.types.TimeUuid.min(date));

CassandraClient.prototype.doBatch = function f(queries, options, callback) {
  if (arguments.length === 2) {
    callback = options;
    options = {};
  }

  const defaults = {
    prepare: true,
  };

  options = _.defaultsDeep(options, defaults);

  const randomModel = this.modelInstance[Object.keys(this.modelInstance)[0]];
  const builtQueries = [];
  const beforeHooks = [];
  for (let i = 0; i < queries.length; i++) {
    builtQueries.push({
      query: queries[i].query,
      params: queries[i].params,
    });
    const beforeHookAsync = Promise.promisify(queries[i].before_hook);
    beforeHooks.push(beforeHookAsync());
  }

  let batchResult;
  Promise.all(beforeHooks)
    .then(() => {
      if (builtQueries.length > 1) {
        return randomModel.execute_batchAsync(builtQueries, options);
      }
      if (builtQueries.length > 0) {
        debug('single query provided for batch request, applying as non batch query');
        return randomModel.execute_queryAsync(builtQueries[0].query, builtQueries[0].params, options);
      }
      debug('no queries provided for batch request, empty array found, doing nothing');
      return {};
    })
    .then((response) => {
      batchResult = response;
      const afterHooks = [];
      for (let i = 0; i < queries.length; i++) {
        const afterHookAsync = Promise.promisify(queries[i].after_hook);
        afterHooks.push(afterHookAsync());
      }
      return Promise.all(afterHooks);
    })
    .then(() => {
      callback(null, batchResult);
    })
    .catch((err) => {
      callback(err);
    });
};

CassandraClient.prototype.doBatchAsync = Promise.promisify(CassandraClient.prototype.doBatch);

CassandraClient.doBatch = function f(queries, options, callback) {
  if (arguments.length === 2) {
    callback = options;
    options = {};
  }

  const defaults = {
    prepare: true,
  };

  options = _.defaultsDeep(options, defaults);

  CassandraClient.prototype.doBatch.call(CassandraClient, queries, options, callback);
};

CassandraClient.doBatchAsync = Promise.promisify(CassandraClient.doBatch);

CassandraClient._translateFileNameToModelName = (fileName) => (
  fileName.slice(0, fileName.lastIndexOf('.')).replace('Model', '')
);

Object.defineProperties(CassandraClient, {
  consistencies: {
    get() {
      return cql.types.consistencies;
    },
  },
  datatypes: {
    get() {
      return cql.types;
    },
  },
  driver: {
    get() {
      return cql;
    },
  },
  instance: {
    get() {
      return CassandraClient.modelInstance;
    },
  },
  close: {
    get() {
      return CassandraClient.orm.close;
    },
  },
  closeAsync: {
    get() {
      return Promise.promisify(CassandraClient.orm.close);
    },
  },
});


Object.defineProperties(CassandraClient.prototype, {
  consistencies: {
    get() {
      return cql.types.consistencies;
    },
  },
  datatypes: {
    get() {
      return cql.types;
    },
  },
  driver: {
    get() {
      return cql;
    },
  },
  instance: {
    get() {
      return this.modelInstance;
    },
  },
  close: {
    get() {
      return this.orm.close;
    },
  },
  closeAsync: {
    get() {
      return Promise.promisify(this.orm.close);
    },
  },
});


CassandraClient.prototype.uuid = CassandraClient.uuid;
CassandraClient.prototype.uuidFromString = CassandraClient.uuidFromString;
CassandraClient.prototype.uuidFromBuffer = CassandraClient.uuidFromBuffer;
CassandraClient.prototype.timeuuid = CassandraClient.timeuuid;
CassandraClient.prototype.timeuuidFromDate = CassandraClient.timeuuidFromDate;
CassandraClient.prototype.timeuuidFromString = CassandraClient.timeuuidFromString;
CassandraClient.prototype.timeuuidFromBuffer = CassandraClient.timeuuidFromBuffer;
CassandraClient.prototype.maxTimeuuid = CassandraClient.maxTimeuuid;
CassandraClient.prototype.minTimeuuid = CassandraClient.minTimeuuid;

CassandraClient.prototype._translateFileNameToModelName = CassandraClient._translateFileNameToModelName;

const CassandraEvents = require('./eventsCassandra');

CassandraClient.events = new CassandraEvents();

CassandraClient.getEvents = function () {
  return CassandraClient.events;
};

module.exports = CassandraClient;
