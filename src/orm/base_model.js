'use strict';

var util = require('util');
var cql = require('dse-driver');
var async = require('async');
var _ = require('lodash');
var deepDiff = require('deep-diff').diff;
var readlineSync = require('readline-sync');
var objectHash = require('object-hash');
var debug = require('debug')('express-cassandra');

var buildError = require('./apollo_error.js');
var schemer = require('./apollo_schemer');

var TYPE_MAP = require('./cassandra_types');

var checkDBTableName = function checkDBTableName(obj) {
  return typeof obj === 'string' && /^[a-zA-Z]+[a-zA-Z0-9_]*/.test(obj);
};

var BaseModel = function f(instanceValues) {
  instanceValues = instanceValues || {};
  var fieldValues = {};
  var fields = this.constructor._properties.schema.fields;
  var methods = this.constructor._properties.schema.methods || {};
  var model = this;

  var defaultSetter = function f1(propName, newValue) {
    if (this[propName] !== newValue) {
      model._modified[propName] = true;
    }
    this[propName] = newValue;
  };

  var defaultGetter = function f1(propName) {
    return this[propName];
  };

  this._modified = {};
  this._validators = {};

  for (var fieldsKeys = Object.keys(fields), i = 0, len = fieldsKeys.length; i < len; i++) {
    var propertyName = fieldsKeys[i];
    var field = fields[fieldsKeys[i]];

    this._validators[propertyName] = this.constructor._get_validators(propertyName);

    var setter = defaultSetter.bind(fieldValues, propertyName);
    var getter = defaultGetter.bind(fieldValues, propertyName);

    if (field.virtual && typeof field.virtual.set === 'function') {
      setter = field.virtual.set.bind(fieldValues);
    }

    if (field.virtual && typeof field.virtual.get === 'function') {
      getter = field.virtual.get.bind(fieldValues);
    }

    var descriptor = {
      enumerable: true,
      set: setter,
      get: getter
    };

    Object.defineProperty(this, propertyName, descriptor);
    if (!field.virtual) {
      this[propertyName] = instanceValues[propertyName];
    }
  }

  for (var methodNames = Object.keys(methods), _i = 0, _len = methodNames.length; _i < _len; _i++) {
    var methodName = methodNames[_i];
    var method = methods[methodName];
    this[methodName] = method;
  }
};

BaseModel._properties = {
  name: null,
  schema: null
};

BaseModel._set_properties = function f(properties) {
  var schema = properties.schema;
  var tableName = schema.table_name || properties.name;

  if (!checkDBTableName(tableName)) {
    throw buildError('model.tablecreation.invalidname', tableName);
  }

  var qualifiedTableName = util.format('"%s"."%s"', properties.keyspace, tableName);

  this._properties = properties;
  this._properties.table_name = tableName;
  this._properties.qualified_table_name = qualifiedTableName;
};

BaseModel._validate = function f(validators, value) {
  if (value == null || _.isPlainObject(value) && value.$db_function) return true;

  for (var v = 0; v < validators.length; v++) {
    if (typeof validators[v].validator === 'function') {
      if (!validators[v].validator(value)) {
        return validators[v].message;
      }
    }
  }
  return true;
};

BaseModel._get_generic_validator_message = function f(value, propName, fieldtype) {
  return util.format('Invalid Value: "%s" for Field: %s (Type: %s)', value, propName, fieldtype);
};

BaseModel._format_validator_rule = function f(rule) {
  if (typeof rule.validator !== 'function') {
    throw buildError('model.validator.invalidrule', 'Rule validator must be a valid function');
  }
  if (!rule.message) {
    rule.message = this._get_generic_validator_message;
  } else if (typeof rule.message === 'string') {
    rule.message = function f1(message) {
      return util.format(message);
    }.bind(null, rule.message);
  } else if (typeof rule.message !== 'function') {
    throw buildError('model.validator.invalidrule', 'Invalid validator message, must be string or a function');
  }

  return rule;
};

BaseModel._get_validators = function f(fieldname) {
  var _this = this;

  var fieldtype = void 0;
  try {
    fieldtype = schemer.get_field_type(this._properties.schema, fieldname);
  } catch (e) {
    throw buildError('model.validator.invalidschema', e.message);
  }

  var validators = [];
  var typeFieldValidator = TYPE_MAP.generic_type_validator(fieldtype);

  if (typeFieldValidator) validators.push(typeFieldValidator);

  var field = this._properties.schema.fields[fieldname];
  if (typeof field.rule !== 'undefined') {
    if (typeof field.rule === 'function') {
      field.rule = {
        validator: field.rule,
        message: this._get_generic_validator_message
      };
      validators.push(field.rule);
    } else {
      if (!_.isPlainObject(field.rule)) {
        throw buildError('model.validator.invalidrule', 'Validation rule must be a function or an object');
      }
      if (field.rule.validator) {
        validators.push(this._format_validator_rule(field.rule));
      } else if (Array.isArray(field.rule.validators)) {
        field.rule.validators.forEach(function (fieldrule) {
          validators.push(_this._format_validator_rule(fieldrule));
        });
      }
    }
  }

  return validators;
};

BaseModel._ask_confirmation = function f(message) {
  var permission = 'y';
  if (!this._properties.disableTTYConfirmation) {
    permission = readlineSync.question(message);
  }
  return permission;
};

BaseModel._ensure_connected = function f(callback) {
  if (!this._properties.cql) {
    this._properties.connect(callback);
  } else {
    callback();
  }
};

BaseModel._execute_definition_query = function f(query, params, callback) {
  var _this2 = this;

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    debug('executing definition query: %s with params: %j', query, params);
    var properties = _this2._properties;
    var conn = properties.define_connection;
    conn.execute(query, params, { prepare: false, fetchSize: 0 }, callback);
  });
};

BaseModel._execute_batch = function f(queries, options, callback) {
  var _this3 = this;

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    debug('executing batch queries: %j', queries);
    _this3._properties.cql.batch(queries, options, callback);
  });
};

BaseModel.execute_batch = function f(queries, options, callback) {
  if (arguments.length === 2) {
    callback = options;
    options = {};
  }

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  this._execute_batch(queries, options, callback);
};

BaseModel.get_cql_client = function f(callback) {
  var _this4 = this;

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    callback(null, _this4._properties.cql);
  });
};

BaseModel._create_table = function f(callback) {
  var _this5 = this;

  var properties = this._properties;
  var tableName = properties.table_name;
  var modelSchema = properties.schema;
  var dropTableOnSchemaChange = properties.dropTableOnSchemaChange;
  var migration = properties.migration;

  // backwards compatible change, dropTableOnSchemaChange will work like migration: 'drop'
  if (!migration) {
    if (dropTableOnSchemaChange) migration = 'drop';else migration = 'safe';
  }
  // always safe migrate if NODE_ENV==='production'
  if (process.env.NODE_ENV === 'production') migration = 'safe';

  // check for existence of table on DB and if it matches this model's schema
  this._get_db_table_schema(function (err, dbSchema) {
    if (err) {
      callback(err);
      return;
    }

    var afterCustomIndex = function afterCustomIndex(err1) {
      if (err1) {
        callback(buildError('model.tablecreation.dbindexcreate', err1));
        return;
      }
      // materialized view creation
      if (modelSchema.materialized_views) {
        async.eachSeries(Object.keys(modelSchema.materialized_views), function (viewName, next) {
          var matViewQuery = _this5._create_materialized_view_query(tableName, viewName, modelSchema.materialized_views[viewName]);
          _this5._execute_definition_query(matViewQuery, [], function (err2, result) {
            if (err2) next(buildError('model.tablecreation.matviewcreate', err2));else next(null, result);
          });
        }, callback);
      } else callback();
    };

    var afterDBIndex = function afterDBIndex(err1) {
      if (err1) {
        callback(buildError('model.tablecreation.dbindexcreate', err1));
        return;
      }
      // custom index creation
      if (modelSchema.custom_indexes) {
        async.eachSeries(modelSchema.custom_indexes, function (idx, next) {
          _this5._execute_definition_query(_this5._create_custom_index_query(tableName, idx), [], function (err2, result) {
            if (err2) next(err2);else next(null, result);
          });
        }, afterCustomIndex);
      } else if (modelSchema.custom_index) {
        var customIndexQuery = _this5._create_custom_index_query(tableName, modelSchema.custom_index);
        _this5._execute_definition_query(customIndexQuery, [], function (err2, result) {
          if (err2) afterCustomIndex(err2);else afterCustomIndex(null, result);
        });
      } else afterCustomIndex();
    };

    var afterDBCreate = function afterDBCreate(err1) {
      if (err1) {
        callback(buildError('model.tablecreation.dbcreate', err1));
        return;
      }
      // index creation
      if (modelSchema.indexes instanceof Array) {
        async.eachSeries(modelSchema.indexes, function (idx, next) {
          _this5._execute_definition_query(_this5._create_index_query(tableName, idx), [], function (err2, result) {
            if (err2) next(err2);else next(null, result);
          });
        }, afterDBIndex);
      } else afterDBIndex();
    };

    if (dbSchema) {
      var normalizedModelSchema = void 0;
      var normalizedDBSchema = void 0;

      try {
        normalizedModelSchema = schemer.normalize_model_schema(modelSchema);
        normalizedDBSchema = schemer.normalize_model_schema(dbSchema);
      } catch (e) {
        throw buildError('model.validator.invalidschema', e.message);
      }

      if (_.isEqual(normalizedModelSchema, normalizedDBSchema)) {
        callback();
      } else {
        var dropRecreateTable = function dropRecreateTable() {
          var permission = _this5._ask_confirmation(util.format('Migration: model schema changed for table "%s", drop table & recreate? (data will be lost!) (y/n): ', tableName));
          if (permission.toLowerCase() === 'y') {
            if (normalizedDBSchema.materialized_views) {
              var mviews = Object.keys(normalizedDBSchema.materialized_views);

              _this5.drop_mviews(mviews, function (err1) {
                if (err1) {
                  callback(buildError('model.tablecreation.matviewdrop', err1));
                  return;
                }

                _this5.drop_table(function (err2) {
                  if (err2) {
                    callback(buildError('model.tablecreation.dbdrop', err2));
                    return;
                  }
                  var createTableQuery = _this5._create_table_query(tableName, modelSchema);
                  _this5._execute_definition_query(createTableQuery, [], afterDBCreate);
                });
              });
            } else {
              _this5.drop_table(function (err1) {
                if (err1) {
                  callback(buildError('model.tablecreation.dbdrop', err1));
                  return;
                }
                var createTableQuery = _this5._create_table_query(tableName, modelSchema);
                _this5._execute_definition_query(createTableQuery, [], afterDBCreate);
              });
            }
          } else {
            callback(buildError('model.tablecreation.schemamismatch', tableName));
          }
        };

        var afterDBAlter = function afterDBAlter(err1) {
          if (err1) {
            if (err1.message !== 'break') callback(err1);
            return;
          }
          // it should create/drop indexes/custom_indexes/materialized_views that are added/removed in model schema
          // remove common indexes/custom_indexes/materialized_views from normalizedModelSchema and normalizedDBSchema
          // then drop all remaining indexes/custom_indexes/materialized_views from normalizedDBSchema
          // and add all remaining indexes/custom_indexes/materialized_views from normalizedModelSchema
          var addedIndexes = _.difference(normalizedModelSchema.indexes, normalizedDBSchema.indexes);
          var removedIndexes = _.difference(normalizedDBSchema.indexes, normalizedModelSchema.indexes);
          var removedIndexNames = [];
          removedIndexes.forEach(function (removedIndex) {
            removedIndexNames.push(dbSchema.index_names[removedIndex]);
          });

          var addedCustomIndexes = _.filter(normalizedModelSchema.custom_indexes, function (obj) {
            return !_.find(normalizedDBSchema.custom_indexes, obj);
          });
          var removedCustomIndexes = _.filter(normalizedDBSchema.custom_indexes, function (obj) {
            return !_.find(normalizedModelSchema.custom_indexes, obj);
          });
          removedCustomIndexes.forEach(function (removedIndex) {
            removedIndexNames.push(dbSchema.index_names[objectHash(removedIndex)]);
          });

          var addedMaterializedViews = _.filter(Object.keys(normalizedModelSchema.materialized_views), function (viewName) {
            return !_.find(normalizedDBSchema.materialized_views, normalizedModelSchema.materialized_views[viewName]);
          });
          var removedMaterializedViews = _.filter(Object.keys(normalizedDBSchema.materialized_views), function (viewName) {
            return !_.find(normalizedModelSchema.materialized_views, normalizedDBSchema.materialized_views[viewName]);
          });

          // remove altered materialized views
          if (removedMaterializedViews.length > 0) {
            var permission = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has removed materialized_views: %j, drop them? (y/n): ', tableName, removedMaterializedViews));
            if (permission.toLowerCase() !== 'y') {
              callback(buildError('model.tablecreation.schemamismatch', tableName));
              return;
            }
          }
          if (removedIndexNames.length > 0) {
            var _permission = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has removed indexes: %j, drop them? (y/n): ', tableName, removedIndexNames));
            if (_permission.toLowerCase() !== 'y') {
              callback(buildError('model.tablecreation.schemamismatch', tableName));
              return;
            }
          }

          _this5.drop_mviews(removedMaterializedViews, function (err2) {
            if (err2) {
              callback(buildError('model.tablecreation.matviewdrop', err2));
              return;
            }

            // remove altered indexes by index name
            _this5.drop_indexes(removedIndexNames, function (err3) {
              if (err3) {
                callback(buildError('model.tablecreation.dbindexdrop', err3));
                return;
              }

              // add altered indexes
              async.eachSeries(addedIndexes, function (idx, next) {
                _this5._execute_definition_query(_this5._create_index_query(tableName, idx), [], function (err4, result) {
                  if (err4) next(err4);else next(null, result);
                });
              }, function (err4) {
                if (err4) {
                  callback(buildError('model.tablecreation.dbindexcreate', err4));
                  return;
                }

                // add altered custom indexes
                async.eachSeries(addedCustomIndexes, function (idx, next) {
                  var customIndexQuery = _this5._create_custom_index_query(tableName, idx);
                  _this5._execute_definition_query(customIndexQuery, [], function (err5, result) {
                    if (err5) next(err5);else next(null, result);
                  });
                }, function (err5) {
                  if (err5) {
                    callback(buildError('model.tablecreation.dbindexcreate', err5));
                    return;
                  }

                  // add altered materialized_views
                  async.eachSeries(addedMaterializedViews, function (viewName, next) {
                    var matViewQuery = _this5._create_materialized_view_query(tableName, viewName, modelSchema.materialized_views[viewName]);
                    _this5._execute_definition_query(matViewQuery, [], function (err6, result) {
                      if (err6) next(buildError('model.tablecreation.matviewcreate', err6));else next(null, result);
                    });
                  }, callback);
                });
              });
            });
          });
        };

        var alterDBTable = function alterDBTable() {
          var differences = deepDiff(normalizedDBSchema.fields, normalizedModelSchema.fields);
          async.eachSeries(differences, function (diff, next) {
            var fieldName = diff.path[0];
            var alterFieldType = function alterFieldType() {
              var permission = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has new type for field "%s", ' + 'alter table to update column type? (y/n): ', tableName, fieldName));
              if (permission.toLowerCase() === 'y') {
                _this5.alter_table('ALTER', fieldName, diff.rhs, function (err1, result) {
                  if (err1) next(buildError('model.tablecreation.dbalter', err1));else next(null, result);
                });
              } else {
                next(buildError('model.tablecreation.schemamismatch', tableName));
              }
            };

            var alterAddField = function alterAddField() {
              var type = '';
              if (diff.path.length > 1) {
                if (diff.path[1] === 'type') {
                  type = diff.rhs;
                  if (normalizedModelSchema.fields[fieldName].typeDef) {
                    type += normalizedModelSchema.fields[fieldName].typeDef;
                  }
                } else {
                  type = normalizedModelSchema.fields[fieldName].type;
                  type += diff.rhs;
                }
              } else {
                type = diff.rhs.type;
                if (diff.rhs.typeDef) type += diff.rhs.typeDef;
              }

              _this5.alter_table('ADD', fieldName, type, function (err1, result) {
                if (err1) next(buildError('model.tablecreation.dbalter', err1));else next(null, result);
              });
            };

            var alterRemoveField = function alterRemoveField(nextCallback) {
              // remove dependent indexes/custom_indexes/materialized_views,
              // update them in normalizedDBSchema, then alter
              var dependentIndexes = [];
              var pullIndexes = [];
              normalizedDBSchema.indexes.forEach(function (dbIndex) {
                var indexSplit = dbIndex.split(/[()]/g);
                var indexFieldName = '';
                if (indexSplit.length > 1) indexFieldName = indexSplit[1];else indexFieldName = indexSplit[0];
                if (indexFieldName === fieldName) {
                  dependentIndexes.push(dbSchema.index_names[dbIndex]);
                  pullIndexes.push(dbIndex);
                }
              });
              _.pullAll(normalizedDBSchema.indexes, pullIndexes);

              var pullCustomIndexes = [];
              normalizedDBSchema.custom_indexes.forEach(function (dbIndex) {
                if (dbIndex.on === fieldName) {
                  dependentIndexes.push(dbSchema.index_names[objectHash(dbIndex)]);
                  pullCustomIndexes.push(dbIndex);
                }
              });
              _.pullAll(normalizedDBSchema.custom_indexes, pullCustomIndexes);

              var dependentViews = [];
              Object.keys(normalizedDBSchema.materialized_views).forEach(function (dbViewName) {
                if (normalizedDBSchema.materialized_views[dbViewName].select.indexOf(fieldName) > -1) {
                  dependentViews.push(dbViewName);
                } else if (normalizedDBSchema.materialized_views[dbViewName].select[0] === '*') {
                  dependentViews.push(dbViewName);
                } else if (normalizedDBSchema.materialized_views[dbViewName].key.indexOf(fieldName) > -1) {
                  dependentViews.push(dbViewName);
                } else if (normalizedDBSchema.materialized_views[dbViewName].key[0] instanceof Array && normalizedDBSchema.materialized_views[dbViewName].key[0].indexOf(fieldName) > -1) {
                  dependentViews.push(dbViewName);
                }
              });
              dependentViews.forEach(function (viewName) {
                delete normalizedDBSchema.materialized_views[viewName];
              });

              _this5.drop_mviews(dependentViews, function (err1) {
                if (err1) {
                  nextCallback(buildError('model.tablecreation.matviewdrop', err1));
                  return;
                }

                _this5.drop_indexes(dependentIndexes, function (err2) {
                  if (err2) {
                    nextCallback(buildError('model.tablecreation.dbindexdrop', err2));
                    return;
                  }

                  _this5.alter_table('DROP', fieldName, '', function (err3, result) {
                    if (err3) nextCallback(buildError('model.tablecreation.dbalter', err3));else nextCallback(null, result);
                  });
                });
              });
            };

            if (diff.kind === 'N') {
              var permission = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has added field "%s", alter table to add column? (y/n): ', tableName, fieldName));
              if (permission.toLowerCase() === 'y') {
                alterAddField();
              } else {
                next(buildError('model.tablecreation.schemamismatch', tableName));
              }
            } else if (diff.kind === 'D') {
              var _permission2 = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has removed field "%s", alter table to drop column? ' + '(column data will be lost & dependent indexes/views will be recreated!) (y/n): ', tableName, fieldName));
              if (_permission2.toLowerCase() === 'y') {
                alterRemoveField(next);
              } else {
                next(buildError('model.tablecreation.schemamismatch', tableName));
              }
            } else if (diff.kind === 'E') {
              // check if the alter field type is possible, otherwise try D and then N
              if (diff.path[1] === 'type') {
                if (diff.lhs === 'int' && diff.rhs === 'varint') {
                  // alter field type possible
                  alterFieldType();
                } else if (normalizedDBSchema.key.indexOf(fieldName) > 0) {
                  // check if field part of clustering key
                  // alter field type impossible
                  var _permission3 = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has new incompatible type for primary key field "%s", ' + 'proceed to recreate table? (y/n): ', tableName, fieldName));
                  if (_permission3.toLowerCase() === 'y') {
                    dropRecreateTable();
                    next(new Error('break'));
                  } else {
                    next(buildError('model.tablecreation.schemamismatch', tableName));
                  }
                } else if (['text', 'ascii', 'bigint', 'boolean', 'decimal', 'double', 'float', 'inet', 'int', 'timestamp', 'timeuuid', 'uuid', 'varchar', 'varint'].indexOf(diff.lhs) > -1 && diff.rhs === 'blob') {
                  // alter field type possible
                  alterFieldType();
                } else if (diff.lhs === 'timeuuid' && diff.rhs === 'uuid') {
                  // alter field type possible
                  alterFieldType();
                } else if (normalizedDBSchema.key[0].indexOf(fieldName) > -1) {
                  // check if field part of partition key
                  // alter field type impossible
                  var _permission4 = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has new incompatible type for primary key field "%s", ' + 'proceed to recreate table? (y/n): ', tableName, fieldName));
                  if (_permission4.toLowerCase() === 'y') {
                    dropRecreateTable();
                    next(new Error('break'));
                  } else {
                    next(buildError('model.tablecreation.schemamismatch', tableName));
                  }
                } else {
                  // alter type impossible
                  var _permission5 = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has new incompatible type for field "%s", drop column ' + 'and recreate? (column data will be lost & dependent indexes/views will be recreated!) (y/n): ', tableName, fieldName));
                  if (_permission5.toLowerCase() === 'y') {
                    alterRemoveField(function (err1) {
                      if (err1) next(err1);else alterAddField();
                    });
                  } else {
                    next(buildError('model.tablecreation.schemamismatch', tableName));
                  }
                }
              } else {
                // alter type impossible
                var _permission6 = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has new incompatible type for field "%s", drop column ' + 'and recreate? (column data will be lost & dependent indexes/views will be recreated!) (y/n): ', tableName, fieldName));
                if (_permission6.toLowerCase() === 'y') {
                  alterRemoveField(function (err1) {
                    if (err1) next(err1);else alterAddField();
                  });
                } else {
                  next(buildError('model.tablecreation.schemamismatch', tableName));
                }
              }
            } else {
              next();
            }
          }, afterDBAlter);
        };

        if (migration === 'alter') {
          // check if table can be altered to match schema
          if (_.isEqual(normalizedModelSchema.key, normalizedDBSchema.key) && _.isEqual(normalizedModelSchema.clustering_order, normalizedDBSchema.clustering_order)) {
            alterDBTable();
          } else {
            dropRecreateTable();
          }
        } else if (migration === 'drop') {
          dropRecreateTable();
        } else {
          callback(buildError('model.tablecreation.schemamismatch', tableName));
        }
      }
    } else {
      // if not existing, it's created
      var createTableQuery = _this5._create_table_query(tableName, modelSchema);
      _this5._execute_definition_query(createTableQuery, [], afterDBCreate);
    }
  });
};

BaseModel._create_table_query = function f(tableName, schema) {
  var rows = [];
  var fieldType = void 0;
  Object.keys(schema.fields).forEach(function (k) {
    if (schema.fields[k].virtual) {
      return;
    }
    var segment = '';
    fieldType = schemer.get_field_type(schema, k);
    if (schema.fields[k].typeDef) {
      segment = util.format('"%s" %s%s', k, fieldType, schema.fields[k].typeDef);
    } else {
      segment = util.format('"%s" %s', k, fieldType);
    }

    if (schema.fields[k].static) {
      segment += ' STATIC';
    }

    rows.push(segment);
  });

  var partitionKey = schema.key[0];
  var clusteringKey = schema.key.slice(1, schema.key.length);
  var clusteringOrder = [];

  for (var field = 0; field < clusteringKey.length; field++) {
    if (schema.clustering_order && schema.clustering_order[clusteringKey[field]] && schema.clustering_order[clusteringKey[field]].toLowerCase() === 'desc') {
      clusteringOrder.push(util.format('"%s" DESC', clusteringKey[field]));
    } else {
      clusteringOrder.push(util.format('"%s" ASC', clusteringKey[field]));
    }
  }

  var clusteringOrderQuery = '';
  if (clusteringOrder.length > 0) {
    clusteringOrderQuery = util.format(' WITH CLUSTERING ORDER BY (%s)', clusteringOrder.toString());
  }

  if (partitionKey instanceof Array) {
    partitionKey = partitionKey.map(function (v) {
      return util.format('"%s"', v);
    }).join(',');
  } else {
    partitionKey = util.format('"%s"', partitionKey);
  }

  if (clusteringKey.length) {
    clusteringKey = clusteringKey.map(function (v) {
      return util.format('"%s"', v);
    }).join(',');
    clusteringKey = util.format(',%s', clusteringKey);
  } else {
    clusteringKey = '';
  }

  var query = util.format('CREATE TABLE IF NOT EXISTS "%s" (%s , PRIMARY KEY((%s)%s))%s;', tableName, rows.join(' , '), partitionKey, clusteringKey, clusteringOrderQuery);

  return query;
};

BaseModel._create_materialized_view_query = function f(tableName, viewName, viewSchema) {
  var rows = [];

  for (var k = 0; k < viewSchema.select.length; k++) {
    if (viewSchema.select[k] === '*') rows.push(util.format('%s', viewSchema.select[k]));else rows.push(util.format('"%s"', viewSchema.select[k]));
  }

  var partitionKey = viewSchema.key[0];
  var clusteringKey = viewSchema.key.slice(1, viewSchema.key.length);
  var clusteringOrder = [];

  for (var field = 0; field < clusteringKey.length; field++) {
    if (viewSchema.clustering_order && viewSchema.clustering_order[clusteringKey[field]] && viewSchema.clustering_order[clusteringKey[field]].toLowerCase() === 'desc') {
      clusteringOrder.push(util.format('"%s" DESC', clusteringKey[field]));
    } else {
      clusteringOrder.push(util.format('"%s" ASC', clusteringKey[field]));
    }
  }

  var clusteringOrderQuery = '';
  if (clusteringOrder.length > 0) {
    clusteringOrderQuery = util.format(' WITH CLUSTERING ORDER BY (%s)', clusteringOrder.toString());
  }

  if (partitionKey instanceof Array) {
    partitionKey = partitionKey.map(function (v) {
      return util.format('"%s"', v);
    }).join(',');
  } else {
    partitionKey = util.format('"%s"', partitionKey);
  }

  if (clusteringKey.length) {
    clusteringKey = clusteringKey.map(function (v) {
      return util.format('"%s"', v);
    }).join(',');
    clusteringKey = util.format(',%s', clusteringKey);
  } else {
    clusteringKey = '';
  }

  var whereClause = partitionKey.split(',').join(' IS NOT NULL AND ');
  if (clusteringKey) whereClause += clusteringKey.split(',').join(' IS NOT NULL AND ');
  whereClause += ' IS NOT NULL';

  var query = util.format('CREATE MATERIALIZED VIEW IF NOT EXISTS "%s" AS SELECT %s FROM "%s" WHERE %s PRIMARY KEY((%s)%s)%s;', viewName, rows.join(' , '), tableName, whereClause, partitionKey, clusteringKey, clusteringOrderQuery);

  return query;
};

BaseModel._create_index_query = function f(tableName, indexName) {
  var query = void 0;
  var indexExpression = indexName.replace(/["\s]/g, '').split(/[()]/g);
  if (indexExpression.length > 1) {
    indexExpression[0] = indexExpression[0].toLowerCase();
    query = util.format('CREATE INDEX IF NOT EXISTS ON "%s" (%s("%s"));', tableName, indexExpression[0], indexExpression[1]);
  } else {
    query = util.format('CREATE INDEX IF NOT EXISTS ON "%s" ("%s");', tableName, indexExpression[0]);
  }

  return query;
};

BaseModel._create_custom_index_query = function f(tableName, customIndex) {
  var query = util.format('CREATE CUSTOM INDEX IF NOT EXISTS ON "%s" ("%s") USING \'%s\'', tableName, customIndex.on, customIndex.using);

  if (Object.keys(customIndex.options).length > 0) {
    query += ' WITH OPTIONS = {';
    Object.keys(customIndex.options).forEach(function (key) {
      query += util.format("'%s': '%s', ", key, customIndex.options[key]);
    });
    query = query.slice(0, -2);
    query += '}';
  }

  query += ';';

  return query;
};

BaseModel._get_db_table_schema = function f(callback) {
  var self = this;

  var tableName = this._properties.table_name;
  var keyspace = this._properties.keyspace;

  var query = 'SELECT * FROM system_schema.columns WHERE table_name = ? AND keyspace_name = ?;';

  self.execute_query(query, [tableName, keyspace], function (err, resultColumns) {
    if (err) {
      callback(buildError('model.tablecreation.dbschemaquery', err));
      return;
    }

    if (!resultColumns.rows || resultColumns.rows.length === 0) {
      callback(null, null);
      return;
    }

    var dbSchema = { fields: {}, typeMaps: {}, staticMaps: {} };

    for (var r = 0; r < resultColumns.rows.length; r++) {
      var row = resultColumns.rows[r];

      dbSchema.fields[row.column_name] = TYPE_MAP.extract_type(row.type);

      var typeMapDef = TYPE_MAP.extract_typeDef(row.type);
      if (typeMapDef.length > 0) {
        dbSchema.typeMaps[row.column_name] = typeMapDef;
      }

      if (row.kind === 'partition_key') {
        if (!dbSchema.key) dbSchema.key = [[]];
        dbSchema.key[0][row.position] = row.column_name;
      } else if (row.kind === 'clustering') {
        if (!dbSchema.key) dbSchema.key = [[]];
        if (!dbSchema.clustering_order) dbSchema.clustering_order = {};

        dbSchema.key[row.position + 1] = row.column_name;
        if (row.clustering_order && row.clustering_order.toLowerCase() === 'desc') {
          dbSchema.clustering_order[row.column_name] = 'DESC';
        } else {
          dbSchema.clustering_order[row.column_name] = 'ASC';
        }
      } else if (row.kind === 'static') {
        dbSchema.staticMaps[row.column_name] = true;
      }
    }

    query = 'SELECT * FROM system_schema.indexes WHERE table_name = ? AND keyspace_name = ?;';

    self.execute_query(query, [tableName, keyspace], function (err1, resultIndexes) {
      if (err1) {
        callback(buildError('model.tablecreation.dbschemaquery', err1));
        return;
      }

      for (var _r = 0; _r < resultIndexes.rows.length; _r++) {
        var _row = resultIndexes.rows[_r];

        if (_row.index_name) {
          var indexOptions = _row.options;
          var target = indexOptions.target;
          target = target.replace(/["\s]/g, '');
          delete indexOptions.target;

          // keeping track of index names to drop index when needed
          if (!dbSchema.index_names) dbSchema.index_names = {};

          if (_row.kind === 'CUSTOM') {
            var using = indexOptions.class_name;
            delete indexOptions.class_name;

            if (!dbSchema.custom_indexes) dbSchema.custom_indexes = [];
            var customIndexObject = {
              on: target,
              using: using,
              options: indexOptions
            };
            dbSchema.custom_indexes.push(customIndexObject);
            dbSchema.index_names[objectHash(customIndexObject)] = _row.index_name;
          } else {
            if (!dbSchema.indexes) dbSchema.indexes = [];
            dbSchema.indexes.push(target);
            dbSchema.index_names[target] = _row.index_name;
          }
        }
      }

      query = 'SELECT view_name,base_table_name FROM system_schema.views WHERE keyspace_name=?;';

      self.execute_query(query, [keyspace], function (err2, resultViews) {
        if (err2) {
          callback(buildError('model.tablecreation.dbschemaquery', err2));
          return;
        }

        for (var _r2 = 0; _r2 < resultViews.rows.length; _r2++) {
          var _row2 = resultViews.rows[_r2];

          if (_row2.base_table_name === tableName) {
            if (!dbSchema.materialized_views) dbSchema.materialized_views = {};
            dbSchema.materialized_views[_row2.view_name] = {};
          }
        }

        if (dbSchema.materialized_views) {
          query = 'SELECT * FROM system_schema.columns WHERE keyspace_name=? and table_name IN ?;';

          self.execute_query(query, [keyspace, Object.keys(dbSchema.materialized_views)], function (err3, resultMatViews) {
            if (err3) {
              callback(buildError('model.tablecreation.dbschemaquery', err3));
              return;
            }

            for (var _r3 = 0; _r3 < resultMatViews.rows.length; _r3++) {
              var _row3 = resultMatViews.rows[_r3];

              if (!dbSchema.materialized_views[_row3.table_name].select) {
                dbSchema.materialized_views[_row3.table_name].select = [];
              }

              dbSchema.materialized_views[_row3.table_name].select.push(_row3.column_name);

              if (_row3.kind === 'partition_key') {
                if (!dbSchema.materialized_views[_row3.table_name].key) {
                  dbSchema.materialized_views[_row3.table_name].key = [[]];
                }

                dbSchema.materialized_views[_row3.table_name].key[0][_row3.position] = _row3.column_name;
              } else if (_row3.kind === 'clustering') {
                if (!dbSchema.materialized_views[_row3.table_name].key) {
                  dbSchema.materialized_views[_row3.table_name].key = [[]];
                }
                if (!dbSchema.materialized_views[_row3.table_name].clustering_order) {
                  dbSchema.materialized_views[_row3.table_name].clustering_order = {};
                }

                dbSchema.materialized_views[_row3.table_name].key[_row3.position + 1] = _row3.column_name;
                if (_row3.clustering_order && _row3.clustering_order.toLowerCase() === 'desc') {
                  dbSchema.materialized_views[_row3.table_name].clustering_order[_row3.column_name] = 'DESC';
                } else {
                  dbSchema.materialized_views[_row3.table_name].clustering_order[_row3.column_name] = 'ASC';
                }
              }
            }

            callback(null, dbSchema);
          });
        } else {
          callback(null, dbSchema);
        }
      });
    });
  });
};

BaseModel._execute_table_query = function f(query, params, options, callback) {
  if (arguments.length === 3) {
    callback = options;
    options = {};
  }

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  var doExecuteQuery = function f1(doquery, docallback) {
    this.execute_query(doquery, params, options, docallback);
  }.bind(this, query);

  if (this.is_table_ready()) {
    doExecuteQuery(callback);
  } else {
    this.init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      doExecuteQuery(callback);
    });
  }
};

BaseModel._get_db_value_expression = function f(fieldname, fieldvalue) {
  var _this6 = this;

  if (fieldvalue == null || fieldvalue === cql.types.unset) {
    return { query_segment: '?', parameter: fieldvalue };
  }

  if (_.isPlainObject(fieldvalue) && fieldvalue.$db_function) {
    return fieldvalue.$db_function;
  }

  var fieldtype = schemer.get_field_type(this._properties.schema, fieldname);
  var validators = this._get_validators(fieldname);

  if (fieldvalue instanceof Array && fieldtype !== 'list' && fieldtype !== 'set' && fieldtype !== 'frozen') {
    var val = fieldvalue.map(function (v) {
      var dbVal = _this6._get_db_value_expression(fieldname, v);

      if (_.isPlainObject(dbVal) && dbVal.query_segment) return dbVal.parameter;
      return dbVal;
    });

    return { query_segment: '?', parameter: val };
  }

  var validationMessage = this._validate(validators, fieldvalue);
  if (validationMessage !== true) {
    throw buildError('model.validator.invalidvalue', validationMessage(fieldvalue, fieldname, fieldtype));
  }

  if (fieldtype === 'counter') {
    var counterQuerySegment = util.format('"%s"', fieldname);
    if (fieldvalue >= 0) counterQuerySegment += ' + ?';else counterQuerySegment += ' - ?';
    fieldvalue = Math.abs(fieldvalue);
    return { query_segment: counterQuerySegment, parameter: fieldvalue };
  }

  return { query_segment: '?', parameter: fieldvalue };
};

BaseModel._parse_query_object = function f(queryObject) {
  var _this7 = this;

  var queryRelations = [];
  var queryParams = [];

  Object.keys(queryObject).forEach(function (k) {
    if (k.indexOf('$') === 0) {
      // search queries based on lucene index or solr
      // escape all single quotes for queries in cassandra
      if (k === '$expr') {
        if (typeof queryObject[k].index === 'string' && typeof queryObject[k].query === 'string') {
          queryRelations.push(util.format("expr(%s,'%s')", queryObject[k].index, queryObject[k].query.replace(/'/g, "''")));
        } else {
          throw buildError('model.find.invalidexpr');
        }
      } else if (k === '$solr_query') {
        if (typeof queryObject[k] === 'string') {
          queryRelations.push(util.format("solr_query='%s'", queryObject[k].replace(/'/g, "''")));
        } else {
          throw buildError('model.find.invalidsolrquery');
        }
      }
      return;
    }

    var whereObject = queryObject[k];
    // Array of operators
    if (!(whereObject instanceof Array)) whereObject = [whereObject];

    for (var fk = 0; fk < whereObject.length; fk++) {
      var fieldRelation = whereObject[fk];

      var cqlOperators = {
        $eq: '=',
        $ne: '!=',
        $gt: '>',
        $lt: '<',
        $gte: '>=',
        $lte: '<=',
        $in: 'IN',
        $like: 'LIKE',
        $token: 'token',
        $contains: 'CONTAINS',
        $contains_key: 'CONTAINS KEY'
      };

      if (_.isPlainObject(fieldRelation)) {
        var validKeys = Object.keys(cqlOperators);
        var fieldRelationKeys = Object.keys(fieldRelation);
        for (var i = 0; i < fieldRelationKeys.length; i++) {
          if (validKeys.indexOf(fieldRelationKeys[i]) < 0) {
            // field relation key invalid
            fieldRelation = { $eq: fieldRelation };
            break;
          }
        }
      } else {
        fieldRelation = { $eq: fieldRelation };
      }

      var relKeys = Object.keys(fieldRelation);
      for (var rk = 0; rk < relKeys.length; rk++) {
        var firstKey = relKeys[rk];
        var firstValue = fieldRelation[firstKey];
        if (firstKey.toLowerCase() in cqlOperators) {
          firstKey = firstKey.toLowerCase();
          var op = cqlOperators[firstKey];

          if (firstKey === '$in' && !(firstValue instanceof Array)) throw buildError('model.find.invalidinop');
          if (firstKey === '$token' && !(firstValue instanceof Object)) throw buildError('model.find.invalidtoken');

          var whereTemplate = '"%s" %s %s';
          if (firstKey === '$token') {
            whereTemplate = 'token("%s") %s token(%s)';

            var tokenRelKeys = Object.keys(firstValue);
            for (var tokenRK = 0; tokenRK < tokenRelKeys.length; tokenRK++) {
              var tokenFirstKey = tokenRelKeys[tokenRK];
              var tokenFirstValue = firstValue[tokenFirstKey];
              tokenFirstKey = tokenFirstKey.toLowerCase();
              if (tokenFirstKey in cqlOperators && tokenFirstKey !== '$token' && tokenFirstKey !== '$in') {
                op = cqlOperators[tokenFirstKey];
              } else {
                throw buildError('model.find.invalidtokenop', tokenFirstKey);
              }

              if (tokenFirstValue instanceof Array) {
                var tokenKeys = k.split(',');
                for (var tokenIndex = 0; tokenIndex < tokenFirstValue.length; tokenIndex++) {
                  tokenKeys[tokenIndex] = tokenKeys[tokenIndex].trim();
                  var dbVal = _this7._get_db_value_expression(tokenKeys[tokenIndex], tokenFirstValue[tokenIndex]);
                  if (_.isPlainObject(dbVal) && dbVal.query_segment) {
                    tokenFirstValue[tokenIndex] = dbVal.query_segment;
                    queryParams.push(dbVal.parameter);
                  } else {
                    tokenFirstValue[tokenIndex] = dbVal;
                  }
                }
                queryRelations.push(util.format(whereTemplate, tokenKeys.join('","'), op, tokenFirstValue.toString()));
              } else {
                var _dbVal = _this7._get_db_value_expression(k, tokenFirstValue);
                if (_.isPlainObject(_dbVal) && _dbVal.query_segment) {
                  queryRelations.push(util.format(whereTemplate, k, op, _dbVal.query_segment));
                  queryParams.push(_dbVal.parameter);
                } else {
                  queryRelations.push(util.format(whereTemplate, k, op, _dbVal));
                }
              }
            }
          } else if (firstKey === '$contains') {
            var fieldtype1 = schemer.get_field_type(_this7._properties.schema, k);
            if (['map', 'list', 'set', 'frozen'].indexOf(fieldtype1) >= 0) {
              if (fieldtype1 === 'map' && _.isPlainObject(firstValue) && Object.keys(firstValue).length === 1) {
                queryRelations.push(util.format('"%s"[%s] %s %s', k, '?', '=', '?'));
                queryParams.push(Object.keys(firstValue)[0]);
                queryParams.push(firstValue[Object.keys(firstValue)[0]]);
              } else {
                queryRelations.push(util.format(whereTemplate, k, op, '?'));
                queryParams.push(firstValue);
              }
            } else {
              throw buildError('model.find.invalidcontainsop');
            }
          } else if (firstKey === '$contains_key') {
            var fieldtype2 = schemer.get_field_type(_this7._properties.schema, k);
            if (['map'].indexOf(fieldtype2) >= 0) {
              queryRelations.push(util.format(whereTemplate, k, op, '?'));
              queryParams.push(firstValue);
            } else {
              throw buildError('model.find.invalidcontainskeyop');
            }
          } else {
            var _dbVal2 = _this7._get_db_value_expression(k, firstValue);
            if (_.isPlainObject(_dbVal2) && _dbVal2.query_segment) {
              queryRelations.push(util.format(whereTemplate, k, op, _dbVal2.query_segment));
              queryParams.push(_dbVal2.parameter);
            } else {
              queryRelations.push(util.format(whereTemplate, k, op, _dbVal2));
            }
          }
        } else {
          throw buildError('model.find.invalidop', firstKey);
        }
      }
    }
  });

  return {
    queryRelations: queryRelations,
    queryParams: queryParams
  };
};

BaseModel._create_where_clause = function f(queryObject) {
  var parsedObject = this._parse_query_object(queryObject);
  var whereClause = {};
  if (parsedObject.queryRelations.length > 0) {
    whereClause.query = util.format('WHERE %s', parsedObject.queryRelations.join(' AND '));
  } else {
    whereClause.query = '';
  }
  whereClause.params = parsedObject.queryParams;
  return whereClause;
};

BaseModel._create_if_clause = function f(queryObject) {
  var parsedObject = this._parse_query_object(queryObject);
  var ifClause = {};
  if (parsedObject.queryRelations.length > 0) {
    ifClause.query = util.format('IF %s', parsedObject.queryRelations.join(' AND '));
  } else {
    ifClause.query = '';
  }
  ifClause.params = parsedObject.queryParams;
  return ifClause;
};

BaseModel._create_find_query = function f(queryObject, options) {
  var orderKeys = [];
  var limit = null;

  Object.keys(queryObject).forEach(function (k) {
    var queryItem = queryObject[k];
    if (k.toLowerCase() === '$orderby') {
      if (!(queryItem instanceof Object)) {
        throw buildError('model.find.invalidorder');
      }
      var orderItemKeys = Object.keys(queryItem);

      for (var i = 0; i < orderItemKeys.length; i++) {
        var cqlOrderDirection = { $asc: 'ASC', $desc: 'DESC' };
        if (orderItemKeys[i].toLowerCase() in cqlOrderDirection) {
          var orderFields = queryItem[orderItemKeys[i]];

          if (!(orderFields instanceof Array)) orderFields = [orderFields];

          for (var j = 0; j < orderFields.length; j++) {
            orderKeys.push(util.format('"%s" %s', orderFields[j], cqlOrderDirection[orderItemKeys[i]]));
          }
        } else {
          throw buildError('model.find.invalidordertype', orderItemKeys[i]);
        }
      }
    } else if (k.toLowerCase() === '$limit') {
      if (typeof queryItem !== 'number') throw buildError('model.find.limittype');
      limit = queryItem;
    }
  });

  var whereClause = this._create_where_clause(queryObject);

  var select = '*';
  if (options.select && _.isArray(options.select) && options.select.length > 0) {
    var selectArray = [];
    for (var i = 0; i < options.select.length; i++) {
      // separate the aggregate function and the column name if select is an aggregate function
      var selection = options.select[i].split(/[( )]/g).filter(function (e) {
        return e;
      });
      if (selection.length === 1) {
        selectArray.push(util.format('"%s"', selection[0]));
      } else if (selection.length === 2 || selection.length === 4) {
        var functionClause = util.format('%s("%s")', selection[0], selection[1]);
        if (selection[2]) functionClause += util.format(' %s', selection[2]);
        if (selection[3]) functionClause += util.format(' %s', selection[3]);

        selectArray.push(functionClause);
      } else if (selection.length === 3) {
        selectArray.push(util.format('"%s" %s %s', selection[0], selection[1], selection[2]));
      } else {
        selectArray.push('*');
      }
    }
    select = selectArray.join(',');
  }

  var query = util.format('SELECT %s %s FROM "%s" %s %s %s', options.distinct ? 'DISTINCT' : '', select, options.materialized_view ? options.materialized_view : this._properties.table_name, whereClause.query, orderKeys.length ? util.format('ORDER BY %s', orderKeys.join(', ')) : ' ', limit ? util.format('LIMIT %s', limit) : ' ');

  if (options.allow_filtering) query += ' ALLOW FILTERING;';else query += ';';

  return { query: query, params: whereClause.params };
};

BaseModel.get_table_name = function f() {
  return this._properties.table_name;
};

BaseModel.is_table_ready = function f() {
  return this._ready === true;
};

BaseModel.init = function f(options, callback) {
  if (!callback) {
    callback = options;
    options = undefined;
  }

  this._ready = true;
  callback();
};

BaseModel.syncDefinition = function f(callback) {
  var _this8 = this;

  var afterCreate = function afterCreate(err, result) {
    if (err) callback(err);else {
      _this8._ready = true;
      callback(null, result);
    }
  };

  this._create_table(afterCreate);
};

BaseModel.execute_query = function f(query, params, options, callback) {
  var _this9 = this;

  if (arguments.length === 3) {
    callback = options;
    options = {};
  }

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    debug('executing query: %s with params: %j', query, params);
    _this9._properties.cql.execute(query, params, options, function (err1, result) {
      if (err1 && err1.code === 8704) {
        _this9._execute_definition_query(query, params, callback);
      } else {
        callback(err1, result);
      }
    });
  });
};

BaseModel.execute_eachRow = function f(query, params, options, onReadable, callback) {
  var _this10 = this;

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    debug('executing eachRow query: %s with params: %j', query, params);
    _this10._properties.cql.eachRow(query, params, options, onReadable, callback);
  });
};

BaseModel._execute_table_eachRow = function f(query, params, options, onReadable, callback) {
  var _this11 = this;

  if (this.is_table_ready()) {
    this.execute_eachRow(query, params, options, onReadable, callback);
  } else {
    this.init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      _this11.execute_eachRow(query, params, options, onReadable, callback);
    });
  }
};

BaseModel.eachRow = function f(queryObject, options, onReadable, callback) {
  var _this12 = this;

  if (arguments.length === 3) {
    var cb = onReadable;
    onReadable = options;
    callback = cb;
    options = {};
  }
  if (typeof onReadable !== 'function') {
    throw buildError('model.find.eachrowerror', 'no valid onReadable function was provided');
  }
  if (typeof callback !== 'function') {
    throw buildError('model.find.cberror');
  }

  var defaults = {
    raw: false,
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  options.return_query = true;
  var selectQuery = this.find(queryObject, options);

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  this._execute_table_eachRow(selectQuery.query, selectQuery.params, queryOptions, function (n, row) {
    if (!options.raw) {
      var ModelConstructor = _this12._properties.get_constructor();
      row = new ModelConstructor(row);
      row._modified = {};
    }
    onReadable(n, row);
  }, function (err, result) {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    callback(err, result);
  });
};

BaseModel.execute_stream = function f(query, params, options, onReadable, callback) {
  var _this13 = this;

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    debug('executing stream query: %s with params: %j', query, params);
    _this13._properties.cql.stream(query, params, options).on('readable', onReadable).on('end', callback);
  });
};

BaseModel._execute_table_stream = function f(query, params, options, onReadable, callback) {
  var _this14 = this;

  if (this.is_table_ready()) {
    this.execute_stream(query, params, options, onReadable, callback);
  } else {
    this.init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      _this14.execute_stream(query, params, options, onReadable, callback);
    });
  }
};

BaseModel.stream = function f(queryObject, options, onReadable, callback) {
  if (arguments.length === 3) {
    var cb = onReadable;
    onReadable = options;
    callback = cb;
    options = {};
  }

  if (typeof onReadable !== 'function') {
    throw buildError('model.find.streamerror', 'no valid onReadable function was provided');
  }
  if (typeof callback !== 'function') {
    throw buildError('model.find.cberror');
  }

  var defaults = {
    raw: false,
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  options.return_query = true;
  var selectQuery = this.find(queryObject, options);

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  var self = this;

  this._execute_table_stream(selectQuery.query, selectQuery.params, queryOptions, function f1() {
    var reader = this;
    reader.readRow = function () {
      var row = reader.read();
      if (!row) return row;
      if (!options.raw) {
        var ModelConstructor = self._properties.get_constructor();
        var o = new ModelConstructor(row);
        o._modified = {};
        return o;
      }
      return row;
    };
    onReadable(reader);
  }, function (err) {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    callback();
  });
};

BaseModel.find = function f(queryObject, options, callback) {
  var _this15 = this;

  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof callback !== 'function' && !options.return_query) {
    throw buildError('model.find.cberror');
  }

  var defaults = {
    raw: false,
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  // set raw true if select is used,
  // because casting to model instances may lead to problems
  if (options.select) options.raw = true;

  var queryParams = [];

  var query = void 0;
  try {
    var findQuery = this._create_find_query(queryObject, options);
    query = findQuery.query;
    queryParams = queryParams.concat(findQuery.params);
  } catch (e) {
    if (typeof callback === 'function') {
      callback(e);
      return {};
    }
    throw e;
  }

  if (options.return_query) {
    return { query: query, params: queryParams };
  }

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  this._execute_table_query(query, queryParams, queryOptions, function (err, results) {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    if (!options.raw) {
      var ModelConstructor = _this15._properties.get_constructor();
      results = results.rows.map(function (res) {
        delete res.columns;
        var o = new ModelConstructor(res);
        o._modified = {};
        return o;
      });
      callback(null, results);
    } else {
      results = results.rows.map(function (res) {
        delete res.columns;
        return res;
      });
      callback(null, results);
    }
  });

  return {};
};

BaseModel.findOne = function f(queryObject, options, callback) {
  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof callback !== 'function' && !options.return_query) {
    throw buildError('model.find.cberror');
  }

  queryObject.$limit = 1;

  return this.find(queryObject, options, function (err, results) {
    if (err) {
      callback(err);
      return;
    }
    if (results.length > 0) {
      callback(null, results[0]);
      return;
    }
    callback();
  });
};

BaseModel.update = function f(queryObject, updateValues, options, callback) {
  var _this16 = this;

  if (arguments.length === 3 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var schema = this._properties.schema;

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  var queryParams = [];

  var updateClauseArray = [];

  // set dummy hook function if not present in schema
  if (typeof schema.before_update !== 'function') {
    schema.before_update = function f1(queryObj, updateVal, optionsObj, next) {
      next();
    };
  }

  if (typeof schema.after_update !== 'function') {
    schema.after_update = function f1(queryObj, updateVal, optionsObj, next) {
      next();
    };
  }

  function hookRunner(fn, errorCode) {
    return function (hookCallback) {
      fn(queryObject, updateValues, options, function (error) {
        if (error) {
          hookCallback(buildError(errorCode, error));
          return;
        }
        hookCallback();
      });
    };
  }

  if (options.return_query) {
    return {
      query: query,
      params: queryParams,
      before_hook: hookRunner(schema.before_update, 'model.update.before.error'),
      after_hook: hookRunner(schema.after_update, 'model.update.after.error')
    };
  }

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  schema.before_update(queryObject, updateValues, options, function (error) {
    if (error) {
      if (typeof callback === 'function') {
        callback(buildError('model.update.before.error', error));
        return;
      }
      throw buildError('model.update.before.error', error);
    }

    var errorHappened = Object.keys(updateValues).some(function (key) {
      if (schema.fields[key] === undefined || schema.fields[key].virtual) return false;

      // check field value
      var fieldtype = schemer.get_field_type(schema, key);
      var fieldvalue = updateValues[key];

      if (fieldvalue === undefined) {
        fieldvalue = _this16._get_default_value(key);
        if (fieldvalue === undefined) {
          if (schema.key.indexOf(key) >= 0 || schema.key[0].indexOf(key) >= 0) {
            if (typeof callback === 'function') {
              callback(buildError('model.update.unsetkey', key));
              return true;
            }
            throw buildError('model.update.unsetkey', key);
          } else if (schema.fields[key].rule && schema.fields[key].rule.required) {
            if (typeof callback === 'function') {
              callback(buildError('model.update.unsetrequired', key));
              return true;
            }
            throw buildError('model.update.unsetrequired', key);
          } else return false;
        } else if (!schema.fields[key].rule || !schema.fields[key].rule.ignore_default) {
          // did set a default value, ignore default is not set
          if (_this16.validate(key, fieldvalue) !== true) {
            if (typeof callback === 'function') {
              callback(buildError('model.update.invaliddefaultvalue', fieldvalue, key, fieldtype));
              return true;
            }
            throw buildError('model.update.invaliddefaultvalue', fieldvalue, key, fieldtype);
          }
        }
      }

      if (fieldvalue === null || fieldvalue === cql.types.unset) {
        if (schema.key.indexOf(key) >= 0 || schema.key[0].indexOf(key) >= 0) {
          if (typeof callback === 'function') {
            callback(buildError('model.update.unsetkey', key));
            return true;
          }
          throw buildError('model.update.unsetkey', key);
        } else if (schema.fields[key].rule && schema.fields[key].rule.required) {
          if (typeof callback === 'function') {
            callback(buildError('model.update.unsetrequired', key));
            return true;
          }
          throw buildError('model.update.unsetrequired', key);
        }
      }

      try {
        var $add = false;
        var $append = false;
        var $prepend = false;
        var $replace = false;
        var $remove = false;
        if (_.isPlainObject(fieldvalue)) {
          if (fieldvalue.$add) {
            fieldvalue = fieldvalue.$add;
            $add = true;
          } else if (fieldvalue.$append) {
            fieldvalue = fieldvalue.$append;
            $append = true;
          } else if (fieldvalue.$prepend) {
            fieldvalue = fieldvalue.$prepend;
            $prepend = true;
          } else if (fieldvalue.$replace) {
            fieldvalue = fieldvalue.$replace;
            $replace = true;
          } else if (fieldvalue.$remove) {
            fieldvalue = fieldvalue.$remove;
            $remove = true;
          }
        }

        var dbVal = _this16._get_db_value_expression(key, fieldvalue);

        if (_.isPlainObject(dbVal) && dbVal.query_segment) {
          if (['map', 'list', 'set'].indexOf(fieldtype) > -1) {
            if ($add || $append) {
              dbVal.query_segment = util.format('"%s" + %s', key, dbVal.query_segment);
            } else if ($prepend) {
              if (fieldtype === 'list') {
                dbVal.query_segment = util.format('%s + "%s"', dbVal.query_segment, key);
              } else {
                throw buildError('model.update.invalidprependop', util.format('%s datatypes does not support $prepend, use $add instead', fieldtype));
              }
            } else if ($remove) {
              dbVal.query_segment = util.format('"%s" - %s', key, dbVal.query_segment);
              if (fieldtype === 'map') dbVal.parameter = Object.keys(dbVal.parameter);
            }
          }

          if ($replace) {
            if (fieldtype === 'map') {
              updateClauseArray.push(util.format('"%s"[?]=%s', key, dbVal.query_segment));
              var replaceKeys = Object.keys(dbVal.parameter);
              var replaceValues = _.values(dbVal.parameter);
              if (replaceKeys.length === 1) {
                queryParams.push(replaceKeys[0]);
                queryParams.push(replaceValues[0]);
              } else {
                throw buildError('model.update.invalidreplaceop', '$replace in map does not support more than one item');
              }
            } else if (fieldtype === 'list') {
              updateClauseArray.push(util.format('"%s"[?]=%s', key, dbVal.query_segment));
              if (dbVal.parameter.length === 2) {
                queryParams.push(dbVal.parameter[0]);
                queryParams.push(dbVal.parameter[1]);
              } else {
                throw buildError('model.update.invalidreplaceop', '$replace in list should have exactly 2 items, first one as the index and the second one as the value');
              }
            } else {
              throw buildError('model.update.invalidreplaceop', util.format('%s datatypes does not support $replace', fieldtype));
            }
          } else {
            updateClauseArray.push(util.format('"%s"=%s', key, dbVal.query_segment));
            queryParams.push(dbVal.parameter);
          }
        } else {
          updateClauseArray.push(util.format('"%s"=%s', key, dbVal));
        }
      } catch (e) {
        if (typeof callback === 'function') {
          callback(e);
          return true;
        }
        throw e;
      }
      return false;
    });

    if (errorHappened) return {};

    var query = 'UPDATE "%s"';
    var where = '';
    if (options.ttl) query += util.format(' USING TTL %s', options.ttl);
    query += ' SET %s %s';
    try {
      var whereClause = _this16._create_where_clause(queryObject);
      where = whereClause.query;
      queryParams = queryParams.concat(whereClause.params);
    } catch (e) {
      if (typeof callback === 'function') {
        callback(e);
        return {};
      }
      throw e;
    }
    query = util.format(query, _this16._properties.table_name, updateClauseArray.join(', '), where);

    if (options.conditions) {
      var ifClause = _this16._create_if_clause(options.conditions);
      if (ifClause.query) {
        query += util.format(' %s', ifClause.query);
        queryParams = queryParams.concat(ifClause.params);
      }
    } else if (options.if_exists) {
      query += ' IF EXISTS';
    }

    query += ';';

    _this16._execute_table_query(query, queryParams, queryOptions, function (err, results) {
      if (typeof callback === 'function') {
        if (err) {
          callback(buildError('model.update.dberror', err));
          return;
        }
        schema.after_update(queryObject, updateValues, options, function (error1) {
          if (error1) {
            callback(buildError('model.update.after.error', error1));
            return;
          }
          callback(null, results);
        });
      } else if (err) {
        throw buildError('model.update.dberror', err);
      } else {
        schema.after_update(queryObject, updateValues, options, function (error1) {
          if (error1) {
            throw buildError('model.update.after.error', error1);
          }
        });
      }
    });
  });

  return {};
};

BaseModel.delete = function f(queryObject, options, callback) {
  var _this17 = this;

  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var schema = this._properties.schema;

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  var queryParams = [];

  var query = 'DELETE FROM "%s" %s;';
  var where = '';
  try {
    var whereClause = this._create_where_clause(queryObject);
    where = whereClause.query;
    queryParams = queryParams.concat(whereClause.params);
  } catch (e) {
    if (typeof callback === 'function') {
      callback(e);
      return {};
    }
    throw e;
  }

  query = util.format(query, this._properties.table_name, where);

  // set dummy hook function if not present in schema
  if (typeof schema.before_delete !== 'function') {
    schema.before_delete = function f1(queryObj, optionsObj, next) {
      next();
    };
  }

  if (typeof schema.after_delete !== 'function') {
    schema.after_delete = function f1(queryObj, optionsObj, next) {
      next();
    };
  }

  if (options.return_query) {
    return {
      query: query,
      params: queryParams,
      before_hook: function before_hook(hookCallback) {
        schema.before_delete(queryObject, options, function (error) {
          if (error) {
            hookCallback(buildError('model.delete.before.error', error));
            return;
          }
          hookCallback();
        });
      },
      after_hook: function after_hook(hookCallback) {
        schema.after_delete(queryObject, options, function (error) {
          if (error) {
            hookCallback(buildError('model.delete.after.error', error));
            return;
          }
          hookCallback();
        });
      }
    };
  }

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  schema.before_delete(queryObject, options, function (error) {
    if (error) {
      if (typeof callback === 'function') {
        callback(buildError('model.delete.before.error', error));
        return;
      }
      throw buildError('model.delete.before.error', error);
    }

    _this17._execute_table_query(query, queryParams, queryOptions, function (err, results) {
      if (typeof callback === 'function') {
        if (err) {
          callback(buildError('model.delete.dberror', err));
          return;
        }
        schema.after_delete(queryObject, options, function (error1) {
          if (error1) {
            callback(buildError('model.delete.after.error', error1));
            return;
          }
          callback(null, results);
        });
      } else if (err) {
        throw buildError('model.delete.dberror', err);
      } else {
        schema.after_delete(queryObject, options, function (error1) {
          if (error1) {
            throw buildError('model.delete.after.error', error1);
          }
        });
      }
    });
  });

  return {};
};

BaseModel.truncate = function f(callback) {
  var properties = this._properties;
  var tableName = properties.table_name;

  var query = util.format('TRUNCATE TABLE "%s";', tableName);
  this._execute_definition_query(query, [], callback);
};

BaseModel.drop_mviews = function f(mviews, callback) {
  var _this18 = this;

  async.each(mviews, function (view, viewCallback) {
    var query = util.format('DROP MATERIALIZED VIEW IF EXISTS "%s";', view);
    _this18._execute_definition_query(query, [], viewCallback);
  }, function (err) {
    if (err) callback(err);else callback();
  });
};

BaseModel.drop_indexes = function f(indexes, callback) {
  var _this19 = this;

  async.each(indexes, function (index, indexCallback) {
    var query = util.format('DROP INDEX IF EXISTS "%s";', index);
    _this19._execute_definition_query(query, [], indexCallback);
  }, function (err) {
    if (err) callback(err);else callback();
  });
};

BaseModel.alter_table = function f(operation, fieldname, type, callback) {
  var properties = this._properties;
  var tableName = properties.table_name;

  if (operation === 'ALTER') type = util.format('TYPE %s', type);else if (operation === 'DROP') type = '';

  var query = util.format('ALTER TABLE "%s" %s "%s" %s;', tableName, operation, fieldname, type);
  this._execute_definition_query(query, [], callback);
};

BaseModel.drop_table = function f(callback) {
  var properties = this._properties;
  var tableName = properties.table_name;

  var query = util.format('DROP TABLE IF EXISTS "%s";', tableName);
  this._execute_definition_query(query, [], callback);
};

BaseModel.prototype._get_data_types = function f() {
  return cql.types;
};

BaseModel.prototype._get_default_value = function f(fieldname) {
  var properties = this.constructor._properties;
  var schema = properties.schema;

  if (_.isPlainObject(schema.fields[fieldname]) && schema.fields[fieldname].default !== undefined) {
    if (typeof schema.fields[fieldname].default === 'function') {
      return schema.fields[fieldname].default.call(this);
    }
    return schema.fields[fieldname].default;
  }
  return undefined;
};

BaseModel.prototype.validate = function f(propertyName, value) {
  value = value || this[propertyName];
  this._validators = this._validators || {};
  return this.constructor._validate(this._validators[propertyName] || [], value);
};

BaseModel.prototype.save = function fn(options, callback) {
  var _this20 = this;

  if (arguments.length === 1 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var identifiers = [];
  var values = [];
  var properties = this.constructor._properties;
  var schema = properties.schema;

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  var queryParams = [];

  // set dummy hook function if not present in schema
  if (typeof schema.before_save !== 'function') {
    schema.before_save = function f(instance, option, next) {
      next();
    };
  }

  if (typeof schema.after_save !== 'function') {
    schema.after_save = function f(instance, option, next) {
      next();
    };
  }

  if (options.return_query) {
    return {
      query: query,
      params: queryParams,
      before_hook: function before_hook(hookCallback) {
        schema.before_save(_this20, options, function (error) {
          if (error) {
            hookCallback(buildError('model.save.before.error', error));
            return;
          }
          hookCallback();
        });
      },
      after_hook: function after_hook(hookCallback) {
        schema.after_save(_this20, options, function (error) {
          if (error) {
            hookCallback(buildError('model.save.after.error', error));
            return;
          }
          hookCallback();
        });
      }
    };
  }

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  schema.before_save(this, options, function (error) {
    if (error) {
      if (typeof callback === 'function') {
        callback(buildError('model.save.before.error', error));
        return;
      }
      throw buildError('model.save.before.error', error);
    }

    var errorHappened = Object.keys(schema.fields).some(function (f) {
      if (schema.fields[f].virtual) return false;

      // check field value
      var fieldtype = schemer.get_field_type(schema, f);
      var fieldvalue = _this20[f];

      if (fieldvalue === undefined) {
        fieldvalue = _this20._get_default_value(f);
        if (fieldvalue === undefined) {
          if (schema.key.indexOf(f) >= 0 || schema.key[0].indexOf(f) >= 0) {
            if (typeof callback === 'function') {
              callback(buildError('model.save.unsetkey', f));
              return true;
            }
            throw buildError('model.save.unsetkey', f);
          } else if (schema.fields[f].rule && schema.fields[f].rule.required) {
            if (typeof callback === 'function') {
              callback(buildError('model.save.unsetrequired', f));
              return true;
            }
            throw buildError('model.save.unsetrequired', f);
          } else return false;
        } else if (!schema.fields[f].rule || !schema.fields[f].rule.ignore_default) {
          // did set a default value, ignore default is not set
          if (_this20.validate(f, fieldvalue) !== true) {
            if (typeof callback === 'function') {
              callback(buildError('model.save.invaliddefaultvalue', fieldvalue, f, fieldtype));
              return true;
            }
            throw buildError('model.save.invaliddefaultvalue', fieldvalue, f, fieldtype);
          }
        }
      }

      if (fieldvalue === null || fieldvalue === cql.types.unset) {
        if (schema.key.indexOf(f) >= 0 || schema.key[0].indexOf(f) >= 0) {
          if (typeof callback === 'function') {
            callback(buildError('model.save.unsetkey', f));
            return true;
          }
          throw buildError('model.save.unsetkey', f);
        } else if (schema.fields[f].rule && schema.fields[f].rule.required) {
          if (typeof callback === 'function') {
            callback(buildError('model.save.unsetrequired', f));
            return true;
          }
          throw buildError('model.save.unsetrequired', f);
        }
      }

      identifiers.push(util.format('"%s"', f));

      try {
        var dbVal = _this20.constructor._get_db_value_expression(f, fieldvalue);
        if (_.isPlainObject(dbVal) && dbVal.query_segment) {
          values.push(dbVal.query_segment);
          queryParams.push(dbVal.parameter);
        } else {
          values.push(dbVal);
        }
      } catch (e) {
        if (typeof callback === 'function') {
          callback(e);
          return true;
        }
        throw e;
      }
      return false;
    });

    if (errorHappened) return {};

    var query = util.format('INSERT INTO "%s" ( %s ) VALUES ( %s )', properties.table_name, identifiers.join(' , '), values.join(' , '));

    if (options.if_not_exist) query += ' IF NOT EXISTS';
    if (options.ttl) query += util.format(' USING TTL %s', options.ttl);

    query += ';';

    _this20.constructor._execute_table_query(query, queryParams, queryOptions, function (err, result) {
      if (typeof callback === 'function') {
        if (err) {
          callback(buildError('model.save.dberror', err));
          return;
        }
        if (!options.if_not_exist || result.rows && result.rows[0] && result.rows[0]['[applied]']) {
          _this20._modified = {};
        }
        schema.after_save(_this20, options, function (error1) {
          if (error1) {
            callback(buildError('model.save.after.error', error1));
            return;
          }
          callback(null, result);
        });
      } else if (err) {
        throw buildError('model.save.dberror', err);
      } else {
        schema.after_save(_this20, options, function (error1) {
          if (error1) {
            throw buildError('model.save.after.error', error1);
          }
        });
      }
    });
  });

  return {};
};

BaseModel.prototype.delete = function f(options, callback) {
  if (arguments.length === 1 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var schema = this.constructor._properties.schema;
  var deleteQuery = {};

  for (var i = 0; i < schema.key.length; i++) {
    var fieldKey = schema.key[i];
    if (fieldKey instanceof Array) {
      for (var j = 0; j < fieldKey.length; j++) {
        deleteQuery[fieldKey[j]] = this[fieldKey[j]];
      }
    } else {
      deleteQuery[fieldKey] = this[fieldKey];
    }
  }

  return this.constructor.delete(deleteQuery, options, callback);
};

BaseModel.prototype.toJSON = function toJSON() {
  var _this21 = this;

  var object = {};
  var schema = this.constructor._properties.schema;

  Object.keys(schema.fields).forEach(function (field) {
    object[field] = _this21[field];
  });

  return object;
};

BaseModel.prototype.isModified = function isModified(propName) {
  if (propName) {
    return Object.prototype.hasOwnProperty.call(this._modified, propName);
  }
  return Object.keys(this._modified).length !== 0;
};

module.exports = BaseModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9vcm0vYmFzZV9tb2RlbC5qcyJdLCJuYW1lcyI6WyJ1dGlsIiwicmVxdWlyZSIsImNxbCIsImFzeW5jIiwiXyIsImRlZXBEaWZmIiwiZGlmZiIsInJlYWRsaW5lU3luYyIsIm9iamVjdEhhc2giLCJkZWJ1ZyIsImJ1aWxkRXJyb3IiLCJzY2hlbWVyIiwiVFlQRV9NQVAiLCJjaGVja0RCVGFibGVOYW1lIiwib2JqIiwidGVzdCIsIkJhc2VNb2RlbCIsImYiLCJpbnN0YW5jZVZhbHVlcyIsImZpZWxkVmFsdWVzIiwiZmllbGRzIiwiY29uc3RydWN0b3IiLCJfcHJvcGVydGllcyIsInNjaGVtYSIsIm1ldGhvZHMiLCJtb2RlbCIsImRlZmF1bHRTZXR0ZXIiLCJmMSIsInByb3BOYW1lIiwibmV3VmFsdWUiLCJfbW9kaWZpZWQiLCJkZWZhdWx0R2V0dGVyIiwiX3ZhbGlkYXRvcnMiLCJmaWVsZHNLZXlzIiwiT2JqZWN0Iiwia2V5cyIsImkiLCJsZW4iLCJsZW5ndGgiLCJwcm9wZXJ0eU5hbWUiLCJmaWVsZCIsIl9nZXRfdmFsaWRhdG9ycyIsInNldHRlciIsImJpbmQiLCJnZXR0ZXIiLCJ2aXJ0dWFsIiwic2V0IiwiZ2V0IiwiZGVzY3JpcHRvciIsImVudW1lcmFibGUiLCJkZWZpbmVQcm9wZXJ0eSIsIm1ldGhvZE5hbWVzIiwibWV0aG9kTmFtZSIsIm1ldGhvZCIsIm5hbWUiLCJfc2V0X3Byb3BlcnRpZXMiLCJwcm9wZXJ0aWVzIiwidGFibGVOYW1lIiwidGFibGVfbmFtZSIsInF1YWxpZmllZFRhYmxlTmFtZSIsImZvcm1hdCIsImtleXNwYWNlIiwicXVhbGlmaWVkX3RhYmxlX25hbWUiLCJfdmFsaWRhdGUiLCJ2YWxpZGF0b3JzIiwidmFsdWUiLCJpc1BsYWluT2JqZWN0IiwiJGRiX2Z1bmN0aW9uIiwidiIsInZhbGlkYXRvciIsIm1lc3NhZ2UiLCJfZ2V0X2dlbmVyaWNfdmFsaWRhdG9yX21lc3NhZ2UiLCJmaWVsZHR5cGUiLCJfZm9ybWF0X3ZhbGlkYXRvcl9ydWxlIiwicnVsZSIsImZpZWxkbmFtZSIsImdldF9maWVsZF90eXBlIiwiZSIsInR5cGVGaWVsZFZhbGlkYXRvciIsImdlbmVyaWNfdHlwZV92YWxpZGF0b3IiLCJwdXNoIiwiQXJyYXkiLCJpc0FycmF5IiwiZm9yRWFjaCIsImZpZWxkcnVsZSIsIl9hc2tfY29uZmlybWF0aW9uIiwicGVybWlzc2lvbiIsImRpc2FibGVUVFlDb25maXJtYXRpb24iLCJxdWVzdGlvbiIsIl9lbnN1cmVfY29ubmVjdGVkIiwiY2FsbGJhY2siLCJjb25uZWN0IiwiX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeSIsInF1ZXJ5IiwicGFyYW1zIiwiZXJyIiwiY29ubiIsImRlZmluZV9jb25uZWN0aW9uIiwiZXhlY3V0ZSIsInByZXBhcmUiLCJmZXRjaFNpemUiLCJfZXhlY3V0ZV9iYXRjaCIsInF1ZXJpZXMiLCJvcHRpb25zIiwiYmF0Y2giLCJleGVjdXRlX2JhdGNoIiwiYXJndW1lbnRzIiwiZGVmYXVsdHMiLCJkZWZhdWx0c0RlZXAiLCJnZXRfY3FsX2NsaWVudCIsIl9jcmVhdGVfdGFibGUiLCJtb2RlbFNjaGVtYSIsImRyb3BUYWJsZU9uU2NoZW1hQ2hhbmdlIiwibWlncmF0aW9uIiwicHJvY2VzcyIsImVudiIsIk5PREVfRU5WIiwiX2dldF9kYl90YWJsZV9zY2hlbWEiLCJkYlNjaGVtYSIsImFmdGVyQ3VzdG9tSW5kZXgiLCJlcnIxIiwibWF0ZXJpYWxpemVkX3ZpZXdzIiwiZWFjaFNlcmllcyIsInZpZXdOYW1lIiwibmV4dCIsIm1hdFZpZXdRdWVyeSIsIl9jcmVhdGVfbWF0ZXJpYWxpemVkX3ZpZXdfcXVlcnkiLCJlcnIyIiwicmVzdWx0IiwiYWZ0ZXJEQkluZGV4IiwiY3VzdG9tX2luZGV4ZXMiLCJpZHgiLCJfY3JlYXRlX2N1c3RvbV9pbmRleF9xdWVyeSIsImN1c3RvbV9pbmRleCIsImN1c3RvbUluZGV4UXVlcnkiLCJhZnRlckRCQ3JlYXRlIiwiaW5kZXhlcyIsIl9jcmVhdGVfaW5kZXhfcXVlcnkiLCJub3JtYWxpemVkTW9kZWxTY2hlbWEiLCJub3JtYWxpemVkREJTY2hlbWEiLCJub3JtYWxpemVfbW9kZWxfc2NoZW1hIiwiaXNFcXVhbCIsImRyb3BSZWNyZWF0ZVRhYmxlIiwidG9Mb3dlckNhc2UiLCJtdmlld3MiLCJkcm9wX212aWV3cyIsImRyb3BfdGFibGUiLCJjcmVhdGVUYWJsZVF1ZXJ5IiwiX2NyZWF0ZV90YWJsZV9xdWVyeSIsImFmdGVyREJBbHRlciIsImFkZGVkSW5kZXhlcyIsImRpZmZlcmVuY2UiLCJyZW1vdmVkSW5kZXhlcyIsInJlbW92ZWRJbmRleE5hbWVzIiwicmVtb3ZlZEluZGV4IiwiaW5kZXhfbmFtZXMiLCJhZGRlZEN1c3RvbUluZGV4ZXMiLCJmaWx0ZXIiLCJmaW5kIiwicmVtb3ZlZEN1c3RvbUluZGV4ZXMiLCJhZGRlZE1hdGVyaWFsaXplZFZpZXdzIiwicmVtb3ZlZE1hdGVyaWFsaXplZFZpZXdzIiwiZHJvcF9pbmRleGVzIiwiZXJyMyIsImVycjQiLCJlcnI1IiwiZXJyNiIsImFsdGVyREJUYWJsZSIsImRpZmZlcmVuY2VzIiwiZmllbGROYW1lIiwicGF0aCIsImFsdGVyRmllbGRUeXBlIiwiYWx0ZXJfdGFibGUiLCJyaHMiLCJhbHRlckFkZEZpZWxkIiwidHlwZSIsInR5cGVEZWYiLCJhbHRlclJlbW92ZUZpZWxkIiwibmV4dENhbGxiYWNrIiwiZGVwZW5kZW50SW5kZXhlcyIsInB1bGxJbmRleGVzIiwiZGJJbmRleCIsImluZGV4U3BsaXQiLCJzcGxpdCIsImluZGV4RmllbGROYW1lIiwicHVsbEFsbCIsInB1bGxDdXN0b21JbmRleGVzIiwib24iLCJkZXBlbmRlbnRWaWV3cyIsImRiVmlld05hbWUiLCJzZWxlY3QiLCJpbmRleE9mIiwia2V5Iiwia2luZCIsImxocyIsIkVycm9yIiwiY2x1c3RlcmluZ19vcmRlciIsInJvd3MiLCJmaWVsZFR5cGUiLCJrIiwic2VnbWVudCIsInN0YXRpYyIsInBhcnRpdGlvbktleSIsImNsdXN0ZXJpbmdLZXkiLCJzbGljZSIsImNsdXN0ZXJpbmdPcmRlciIsImNsdXN0ZXJpbmdPcmRlclF1ZXJ5IiwidG9TdHJpbmciLCJtYXAiLCJqb2luIiwidmlld1NjaGVtYSIsIndoZXJlQ2xhdXNlIiwiaW5kZXhOYW1lIiwiaW5kZXhFeHByZXNzaW9uIiwicmVwbGFjZSIsImN1c3RvbUluZGV4IiwidXNpbmciLCJzZWxmIiwiZXhlY3V0ZV9xdWVyeSIsInJlc3VsdENvbHVtbnMiLCJ0eXBlTWFwcyIsInN0YXRpY01hcHMiLCJyIiwicm93IiwiY29sdW1uX25hbWUiLCJleHRyYWN0X3R5cGUiLCJ0eXBlTWFwRGVmIiwiZXh0cmFjdF90eXBlRGVmIiwicG9zaXRpb24iLCJyZXN1bHRJbmRleGVzIiwiaW5kZXhfbmFtZSIsImluZGV4T3B0aW9ucyIsInRhcmdldCIsImNsYXNzX25hbWUiLCJjdXN0b21JbmRleE9iamVjdCIsInJlc3VsdFZpZXdzIiwiYmFzZV90YWJsZV9uYW1lIiwidmlld19uYW1lIiwicmVzdWx0TWF0Vmlld3MiLCJfZXhlY3V0ZV90YWJsZV9xdWVyeSIsImRvRXhlY3V0ZVF1ZXJ5IiwiZG9xdWVyeSIsImRvY2FsbGJhY2siLCJpc190YWJsZV9yZWFkeSIsImluaXQiLCJfZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24iLCJmaWVsZHZhbHVlIiwidHlwZXMiLCJ1bnNldCIsInF1ZXJ5X3NlZ21lbnQiLCJwYXJhbWV0ZXIiLCJ2YWwiLCJkYlZhbCIsInZhbGlkYXRpb25NZXNzYWdlIiwiY291bnRlclF1ZXJ5U2VnbWVudCIsIk1hdGgiLCJhYnMiLCJfcGFyc2VfcXVlcnlfb2JqZWN0IiwicXVlcnlPYmplY3QiLCJxdWVyeVJlbGF0aW9ucyIsInF1ZXJ5UGFyYW1zIiwiaW5kZXgiLCJ3aGVyZU9iamVjdCIsImZrIiwiZmllbGRSZWxhdGlvbiIsImNxbE9wZXJhdG9ycyIsIiRlcSIsIiRuZSIsIiRndCIsIiRsdCIsIiRndGUiLCIkbHRlIiwiJGluIiwiJGxpa2UiLCIkdG9rZW4iLCIkY29udGFpbnMiLCIkY29udGFpbnNfa2V5IiwidmFsaWRLZXlzIiwiZmllbGRSZWxhdGlvbktleXMiLCJyZWxLZXlzIiwicmsiLCJmaXJzdEtleSIsImZpcnN0VmFsdWUiLCJvcCIsIndoZXJlVGVtcGxhdGUiLCJ0b2tlblJlbEtleXMiLCJ0b2tlblJLIiwidG9rZW5GaXJzdEtleSIsInRva2VuRmlyc3RWYWx1ZSIsInRva2VuS2V5cyIsInRva2VuSW5kZXgiLCJ0cmltIiwiZmllbGR0eXBlMSIsImZpZWxkdHlwZTIiLCJfY3JlYXRlX3doZXJlX2NsYXVzZSIsInBhcnNlZE9iamVjdCIsIl9jcmVhdGVfaWZfY2xhdXNlIiwiaWZDbGF1c2UiLCJfY3JlYXRlX2ZpbmRfcXVlcnkiLCJvcmRlcktleXMiLCJsaW1pdCIsInF1ZXJ5SXRlbSIsIm9yZGVySXRlbUtleXMiLCJjcWxPcmRlckRpcmVjdGlvbiIsIiRhc2MiLCIkZGVzYyIsIm9yZGVyRmllbGRzIiwiaiIsInNlbGVjdEFycmF5Iiwic2VsZWN0aW9uIiwiZnVuY3Rpb25DbGF1c2UiLCJkaXN0aW5jdCIsIm1hdGVyaWFsaXplZF92aWV3IiwiYWxsb3dfZmlsdGVyaW5nIiwiZ2V0X3RhYmxlX25hbWUiLCJfcmVhZHkiLCJ1bmRlZmluZWQiLCJzeW5jRGVmaW5pdGlvbiIsImFmdGVyQ3JlYXRlIiwiY29kZSIsImV4ZWN1dGVfZWFjaFJvdyIsIm9uUmVhZGFibGUiLCJlYWNoUm93IiwiX2V4ZWN1dGVfdGFibGVfZWFjaFJvdyIsImNiIiwicmF3IiwicmV0dXJuX3F1ZXJ5Iiwic2VsZWN0UXVlcnkiLCJxdWVyeU9wdGlvbnMiLCJjb25zaXN0ZW5jeSIsImF1dG9QYWdlIiwiaGludHMiLCJwYWdlU3RhdGUiLCJyZXRyeSIsInNlcmlhbENvbnNpc3RlbmN5IiwibiIsIk1vZGVsQ29uc3RydWN0b3IiLCJnZXRfY29uc3RydWN0b3IiLCJleGVjdXRlX3N0cmVhbSIsInN0cmVhbSIsIl9leGVjdXRlX3RhYmxlX3N0cmVhbSIsInJlYWRlciIsInJlYWRSb3ciLCJyZWFkIiwibyIsImZpbmRRdWVyeSIsImNvbmNhdCIsInJlc3VsdHMiLCJyZXMiLCJjb2x1bW5zIiwiZmluZE9uZSIsIiRsaW1pdCIsInVwZGF0ZSIsInVwZGF0ZVZhbHVlcyIsInVwZGF0ZUNsYXVzZUFycmF5IiwiZXJyb3JIYXBwZW5lZCIsInNvbWUiLCJfZ2V0X2RlZmF1bHRfdmFsdWUiLCJyZXF1aXJlZCIsImlnbm9yZV9kZWZhdWx0IiwidmFsaWRhdGUiLCIkYWRkIiwiJGFwcGVuZCIsIiRwcmVwZW5kIiwiJHJlcGxhY2UiLCIkcmVtb3ZlIiwicmVwbGFjZUtleXMiLCJyZXBsYWNlVmFsdWVzIiwidmFsdWVzIiwid2hlcmUiLCJ0dGwiLCJjb25kaXRpb25zIiwiaWZfZXhpc3RzIiwiYmVmb3JlX3VwZGF0ZSIsInF1ZXJ5T2JqIiwidXBkYXRlVmFsIiwib3B0aW9uc09iaiIsImFmdGVyX3VwZGF0ZSIsImhvb2tSdW5uZXIiLCJmbiIsImVycm9yQ29kZSIsImhvb2tDYWxsYmFjayIsImVycm9yIiwiYmVmb3JlX2hvb2siLCJhZnRlcl9ob29rIiwiZXJyb3IxIiwiZGVsZXRlIiwiYmVmb3JlX2RlbGV0ZSIsImFmdGVyX2RlbGV0ZSIsInRydW5jYXRlIiwiZWFjaCIsInZpZXciLCJ2aWV3Q2FsbGJhY2siLCJpbmRleENhbGxiYWNrIiwib3BlcmF0aW9uIiwicHJvdG90eXBlIiwiX2dldF9kYXRhX3R5cGVzIiwiZGVmYXVsdCIsImNhbGwiLCJzYXZlIiwiaWRlbnRpZmllcnMiLCJpZl9ub3RfZXhpc3QiLCJiZWZvcmVfc2F2ZSIsImluc3RhbmNlIiwib3B0aW9uIiwiYWZ0ZXJfc2F2ZSIsImRlbGV0ZVF1ZXJ5IiwiZmllbGRLZXkiLCJ0b0pTT04iLCJvYmplY3QiLCJpc01vZGlmaWVkIiwiaGFzT3duUHJvcGVydHkiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOztBQUFBLElBQU1BLE9BQU9DLFFBQVEsTUFBUixDQUFiO0FBQ0EsSUFBTUMsTUFBTUQsUUFBUSxZQUFSLENBQVo7QUFDQSxJQUFNRSxRQUFRRixRQUFRLE9BQVIs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LEVBQThDYixRQUE5QyxDQUFQO0FBQ0QsQ0FyQkQ7O0FBdUJBMUUsVUFBVTJYLFNBQVYsQ0FBb0JhLE1BQXBCLEdBQTZCLFNBQVNBLE1BQVQsR0FBa0I7QUFBQTs7QUFDN0MsTUFBTUMsU0FBUyxFQUFmO0FBQ0EsTUFBTWxZLFNBQVMsS0FBS0YsV0FBTCxDQUFpQkMsV0FBakIsQ0FBNkJDLE1BQTVDOztBQUVBVyxTQUFPQyxJQUFQLENBQVlaLE9BQU9ILE1BQW5CLEVBQTJCK0QsT0FBM0IsQ0FBbUMsVUFBQzNDLEtBQUQsRUFBVztBQUM1Q2lYLFdBQU9qWCxLQUFQLElBQWdCLFFBQUtBLEtBQUwsQ0FBaEI7QUFDRCxHQUZEOztBQUlBLFNBQU9pWCxNQUFQO0FBQ0QsQ0FURDs7QUFXQXpZLFVBQVUyWCxTQUFWLENBQW9CZSxVQUFwQixHQUFpQyxTQUFTQSxVQUFULENBQW9COVgsUUFBcEIsRUFBOEI7QUFDN0QsTUFBSUEsUUFBSixFQUFjO0FBQ1osV0FBT00sT0FBT3lXLFNBQVAsQ0FBaUJnQixjQUFqQixDQUFnQ2IsSUFBaEMsQ0FBcUMsS0FBS2hYLFNBQTFDLEVBQXFERixRQUFyRCxDQUFQO0FBQ0Q7QUFDRCxTQUFPTSxPQUFPQyxJQUFQLENBQVksS0FBS0wsU0FBakIsRUFBNEJRLE1BQTVCLEtBQXVDLENBQTlDO0FBQ0QsQ0FMRDs7QUFPQXNYLE9BQU9DLE9BQVAsR0FBaUI3WSxTQUFqQiIsImZpbGUiOiJiYXNlX21vZGVsLmpzIiwic291cmNlc0NvbnRlbnQiOlsiY29uc3QgdXRpbCA9IHJlcXVpcmUoJ3V0aWwnKTtcbmNvbnN0IGNxbCA9IHJlcXVpcmUoJ2RzZS1kcml2ZXInKTtcbmNvbnN0IGFzeW5jID0gcmVxdWlyZSgnYXN5bmMnKTtcbmNvbnN0IF8gPSByZXF1aXJlKCdsb2Rhc2gnKTtcbmNvbnN0IGRlZXBEaWZmID0gcmVxdWlyZSgnZGVlcC1kaWZmJykuZGlmZjtcbmNvbnN0IHJlYWRsaW5lU3luYyA9IHJlcXVpcmUoJ3JlYWRsaW5lLXN5bmMnKTtcbmNvbnN0IG9iamVjdEhhc2ggPSByZXF1aXJlKCdvYmplY3QtaGFzaCcpO1xuY29uc3QgZGVidWcgPSByZXF1aXJlKCdkZWJ1ZycpKCdleHByZXNzLWNhc3NhbmRyYScpO1xuXG5jb25zdCBidWlsZEVycm9yID0gcmVxdWlyZSgnLi9hcG9sbG9fZXJyb3IuanMnKTtcbmNvbnN0IHNjaGVtZXIgPSByZXF1aXJlKCcuL2Fwb2xsb19zY2hlbWVyJyk7XG5cbmNvbnN0IFRZUEVfTUFQID0gcmVxdWlyZSgnLi9jYXNzYW5kcmFfdHlwZXMnKTtcblxuY29uc3QgY2hlY2tEQlRhYmxlTmFtZSA9IChvYmopID0+ICgodHlwZW9mIG9iaiA9PT0gJ3N0cmluZycgJiYgL15bYS16QS1aXStbYS16QS1aMC05X10qLy50ZXN0KG9iaikpKTtcblxuY29uc3QgQmFzZU1vZGVsID0gZnVuY3Rpb24gZihpbnN0YW5jZVZhbHVlcykge1xuICBpbnN0YW5jZVZhbHVlcyA9IGluc3RhbmNlVmFsdWVzIHx8IHt9O1xuICBjb25zdCBmaWVsZFZhbHVlcyA9IHt9O1xuICBjb25zdCBmaWVsZHMgPSB0aGlzLmNvbnN0cnVjdG9yLl9wcm9wZXJ0aWVzLnNjaGVtYS5maWVsZHM7XG4gIGNvbnN0IG1ldGhvZHMgPSB0aGlzLmNvbnN0cnVjdG9yLl9wcm9wZXJ0aWVzLnNjaGVtYS5tZXRob2RzIHx8IHt9O1xuICBjb25zdCBtb2RlbCA9IHRoaXM7XG5cbiAgY29uc3QgZGVmYXVsdFNldHRlciA9IGZ1bmN0aW9uIGYxKHByb3BOYW1lLCBuZXdWYWx1ZSkge1xuICAgIGlmICh0aGlzW3Byb3BOYW1lXSAhPT0gbmV3VmFsdWUpIHtcbiAgICAgIG1vZGVsLl9tb2RpZmllZFtwcm9wTmFtZV0gPSB0cnVlO1xuICAgIH1cbiAgICB0aGlzW3Byb3BOYW1lXSA9IG5ld1ZhbHVlO1xuICB9O1xuXG4gIGNvbnN0IGRlZmF1bHRHZXR0ZXIgPSBmdW5jdGlvbiBmMShwcm9wTmFtZSkge1xuICAgIHJldHVybiB0aGlzW3Byb3BOYW1lXTtcbiAgfTtcblxuICB0aGlzLl9tb2RpZmllZCA9IHt9O1xuICB0aGlzLl92YWxpZGF0b3JzID0ge307XG5cbiAgZm9yIChsZXQgZmllbGRzS2V5cyA9IE9iamVjdC5rZXlzKGZpZWxkcyksIGkgPSAwLCBsZW4gPSBmaWVsZHNLZXlzLmxlbmd0aDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgY29uc3QgcHJvcGVydHlOYW1lID0gZmllbGRzS2V5c1tpXTtcbiAgICBjb25zdCBmaWVsZCA9IGZpZWxkc1tmaWVsZHNLZXlzW2ldXTtcblxuICAgIHRoaXMuX3ZhbGlkYXRvcnNbcHJvcGVydHlOYW1lXSA9IHRoaXMuY29uc3RydWN0b3IuX2dldF92YWxpZGF0b3JzKHByb3BlcnR5TmFtZSk7XG5cbiAgICBsZXQgc2V0dGVyID0gZGVmYXVsdFNldHRlci5iaW5kKGZpZWxkVmFsdWVzLCBwcm9wZXJ0eU5hbWUpO1xuICAgIGxldCBnZXR0ZXIgPSBkZWZhdWx0R2V0dGVyLmJpbmQoZmllbGRWYWx1ZXMsIHByb3BlcnR5TmFtZSk7XG5cbiAgICBpZiAoZmllbGQudmlydHVhbCAmJiB0eXBlb2YgZmllbGQudmlydHVhbC5zZXQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHNldHRlciA9IGZpZWxkLnZpcnR1YWwuc2V0LmJpbmQoZmllbGRWYWx1ZXMpO1xuICAgIH1cblxuICAgIGlmIChmaWVsZC52aXJ0dWFsICYmIHR5cGVvZiBmaWVsZC52aXJ0dWFsLmdldCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgZ2V0dGVyID0gZmllbGQudmlydHVhbC5nZXQuYmluZChmaWVsZFZhbHVlcyk7XG4gICAgfVxuXG4gICAgY29uc3QgZGVzY3JpcHRvciA9IHtcbiAgICAgIGVudW1lcmFibGU6IHRydWUsXG4gICAgICBzZXQ6IHNldHRlcixcbiAgICAgIGdldDogZ2V0dGVyLFxuICAgIH07XG5cbiAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkodGhpcywgcHJvcGVydHlOYW1lLCBkZXNjcmlwdG9yKTtcbiAgICBpZiAoIWZpZWxkLnZpcnR1YWwpIHtcbiAgICAgIHRoaXNbcHJvcGVydHlOYW1lXSA9IGluc3RhbmNlVmFsdWVzW3Byb3BlcnR5TmFtZV07XG4gICAgfVxuICB9XG5cbiAgZm9yIChsZXQgbWV0aG9kTmFtZXMgPSBPYmplY3Qua2V5cyhtZXRob2RzKSwgaSA9IDAsIGxlbiA9IG1ldGhvZE5hbWVzLmxlbmd0aDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgY29uc3QgbWV0aG9kTmFtZSA9IG1ldGhvZE5hbWVzW2ldO1xuICAgIGNvbnN0IG1ldGhvZCA9IG1ldGhvZHNbbWV0aG9kTmFtZV07XG4gICAgdGhpc1ttZXRob2ROYW1lXSA9IG1ldGhvZDtcbiAgfVxufTtcblxuQmFzZU1vZGVsLl9wcm9wZXJ0aWVzID0ge1xuICBuYW1lOiBudWxsLFxuICBzY2hlbWE6IG51bGwsXG59O1xuXG5CYXNlTW9kZWwuX3NldF9wcm9wZXJ0aWVzID0gZnVuY3Rpb24gZihwcm9wZXJ0aWVzKSB7XG4gIGNvbnN0IHNjaGVtYSA9IHByb3BlcnRpZXMuc2NoZW1hO1xuICBjb25zdCB0YWJsZU5hbWUgPSBzY2hlbWEudGFibGVfbmFtZSB8fCBwcm9wZXJ0aWVzLm5hbWU7XG5cbiAgaWYgKCFjaGVja0RCVGFibGVOYW1lKHRhYmxlTmFtZSkpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5pbnZhbGlkbmFtZScsIHRhYmxlTmFtZSkpO1xuICB9XG5cbiAgY29uc3QgcXVhbGlmaWVkVGFibGVOYW1lID0gdXRpbC5mb3JtYXQoJ1wiJXNcIi5cIiVzXCInLCBwcm9wZXJ0aWVzLmtleXNwYWNlLCB0YWJsZU5hbWUpO1xuXG4gIHRoaXMuX3Byb3BlcnRpZXMgPSBwcm9wZXJ0aWVzO1xuICB0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWUgPSB0YWJsZU5hbWU7XG4gIHRoaXMuX3Byb3BlcnRpZXMucXVhbGlmaWVkX3RhYmxlX25hbWUgPSBxdWFsaWZpZWRUYWJsZU5hbWU7XG59O1xuXG5CYXNlTW9kZWwuX3ZhbGlkYXRlID0gZnVuY3Rpb24gZih2YWxpZGF0b3JzLCB2YWx1ZSkge1xuICBpZiAodmFsdWUgPT0gbnVsbCB8fCAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSAmJiB2YWx1ZS4kZGJfZnVuY3Rpb24pKSByZXR1cm4gdHJ1ZTtcblxuICBmb3IgKGxldCB2ID0gMDsgdiA8IHZhbGlkYXRvcnMubGVuZ3RoOyB2KyspIHtcbiAgICBpZiAodHlwZW9mIHZhbGlkYXRvcnNbdl0udmFsaWRhdG9yID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBpZiAoIXZhbGlkYXRvcnNbdl0udmFsaWRhdG9yKHZhbHVlKSkge1xuICAgICAgICByZXR1cm4gdmFsaWRhdG9yc1t2XS5tZXNzYWdlO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn07XG5cbkJhc2VNb2RlbC5fZ2V0X2dlbmVyaWNfdmFsaWRhdG9yX21lc3NhZ2UgPSBmdW5jdGlvbiBmKHZhbHVlLCBwcm9wTmFtZSwgZmllbGR0eXBlKSB7XG4gIHJldHVybiB1dGlsLmZvcm1hdCgnSW52YWxpZCBWYWx1ZTogXCIlc1wiIGZvciBGaWVsZDogJXMgKFR5cGU6ICVzKScsIHZhbHVlLCBwcm9wTmFtZSwgZmllbGR0eXBlKTtcbn07XG5cbkJhc2VNb2RlbC5fZm9ybWF0X3ZhbGlkYXRvcl9ydWxlID0gZnVuY3Rpb24gZihydWxlKSB7XG4gIGlmICh0eXBlb2YgcnVsZS52YWxpZGF0b3IgIT09ICdmdW5jdGlvbicpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWRydWxlJywgJ1J1bGUgdmFsaWRhdG9yIG11c3QgYmUgYSB2YWxpZCBmdW5jdGlvbicpKTtcbiAgfVxuICBpZiAoIXJ1bGUubWVzc2FnZSkge1xuICAgIHJ1bGUubWVzc2FnZSA9IHRoaXMuX2dldF9nZW5lcmljX3ZhbGlkYXRvcl9tZXNzYWdlO1xuICB9IGVsc2UgaWYgKHR5cGVvZiBydWxlLm1lc3NhZ2UgPT09ICdzdHJpbmcnKSB7XG4gICAgcnVsZS5tZXNzYWdlID0gZnVuY3Rpb24gZjEobWVzc2FnZSkge1xuICAgICAgcmV0dXJuIHV0aWwuZm9ybWF0KG1lc3NhZ2UpO1xuICAgIH0uYmluZChudWxsLCBydWxlLm1lc3NhZ2UpO1xuICB9IGVsc2UgaWYgKHR5cGVvZiBydWxlLm1lc3NhZ2UgIT09ICdmdW5jdGlvbicpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWRydWxlJywgJ0ludmFsaWQgdmFsaWRhdG9yIG1lc3NhZ2UsIG11c3QgYmUgc3RyaW5nIG9yIGEgZnVuY3Rpb24nKSk7XG4gIH1cblxuICByZXR1cm4gcnVsZTtcbn07XG5cbkJhc2VNb2RlbC5fZ2V0X3ZhbGlkYXRvcnMgPSBmdW5jdGlvbiBmKGZpZWxkbmFtZSkge1xuICBsZXQgZmllbGR0eXBlO1xuICB0cnkge1xuICAgIGZpZWxkdHlwZSA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUodGhpcy5fcHJvcGVydGllcy5zY2hlbWEsIGZpZWxkbmFtZSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWRzY2hlbWEnLCBlLm1lc3NhZ2UpKTtcbiAgfVxuXG4gIGNvbnN0IHZhbGlkYXRvcnMgPSBbXTtcbiAgY29uc3QgdHlwZUZpZWxkVmFsaWRhdG9yID0gVFlQRV9NQVAuZ2VuZXJpY190eXBlX3ZhbGlkYXRvcihmaWVsZHR5cGUpO1xuXG4gIGlmICh0eXBlRmllbGRWYWxpZGF0b3IpIHZhbGlkYXRvcnMucHVzaCh0eXBlRmllbGRWYWxpZGF0b3IpO1xuXG4gIGNvbnN0IGZpZWxkID0gdGhpcy5fcHJvcGVydGllcy5zY2hlbWEuZmllbGRzW2ZpZWxkbmFtZV07XG4gIGlmICh0eXBlb2YgZmllbGQucnVsZSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICBpZiAodHlwZW9mIGZpZWxkLnJ1bGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIGZpZWxkLnJ1bGUgPSB7XG4gICAgICAgIHZhbGlkYXRvcjogZmllbGQucnVsZSxcbiAgICAgICAgbWVzc2FnZTogdGhpcy5fZ2V0X2dlbmVyaWNfdmFsaWRhdG9yX21lc3NhZ2UsXG4gICAgICB9O1xuICAgICAgdmFsaWRhdG9ycy5wdXNoKGZpZWxkLnJ1bGUpO1xuICAgIH0gZWxzZSB7XG4gICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChmaWVsZC5ydWxlKSkge1xuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWRydWxlJywgJ1ZhbGlkYXRpb24gcnVsZSBtdXN0IGJlIGEgZnVuY3Rpb24gb3IgYW4gb2JqZWN0JykpO1xuICAgICAgfVxuICAgICAgaWYgKGZpZWxkLnJ1bGUudmFsaWRhdG9yKSB7XG4gICAgICAgIHZhbGlkYXRvcnMucHVzaCh0aGlzLl9mb3JtYXRfdmFsaWRhdG9yX3J1bGUoZmllbGQucnVsZSkpO1xuICAgICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KGZpZWxkLnJ1bGUudmFsaWRhdG9ycykpIHtcbiAgICAgICAgZmllbGQucnVsZS52YWxpZGF0b3JzLmZvckVhY2goKGZpZWxkcnVsZSkgPT4ge1xuICAgICAgICAgIHZhbGlkYXRvcnMucHVzaCh0aGlzLl9mb3JtYXRfdmFsaWRhdG9yX3J1bGUoZmllbGRydWxlKSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB2YWxpZGF0b3JzO1xufTtcblxuQmFzZU1vZGVsLl9hc2tfY29uZmlybWF0aW9uID0gZnVuY3Rpb24gZihtZXNzYWdlKSB7XG4gIGxldCBwZXJtaXNzaW9uID0gJ3knO1xuICBpZiAoIXRoaXMuX3Byb3BlcnRpZXMuZGlzYWJsZVRUWUNvbmZpcm1hdGlvbikge1xuICAgIHBlcm1pc3Npb24gPSByZWFkbGluZVN5bmMucXVlc3Rpb24obWVzc2FnZSk7XG4gIH1cbiAgcmV0dXJuIHBlcm1pc3Npb247XG59O1xuXG5CYXNlTW9kZWwuX2Vuc3VyZV9jb25uZWN0ZWQgPSBmdW5jdGlvbiBmKGNhbGxiYWNrKSB7XG4gIGlmICghdGhpcy5fcHJvcGVydGllcy5jcWwpIHtcbiAgICB0aGlzLl9wcm9wZXJ0aWVzLmNvbm5lY3QoY2FsbGJhY2spO1xuICB9IGVsc2Uge1xuICAgIGNhbGxiYWNrKCk7XG4gIH1cbn07XG5cbkJhc2VNb2RlbC5fZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5ID0gZnVuY3Rpb24gZihxdWVyeSwgcGFyYW1zLCBjYWxsYmFjaykge1xuICB0aGlzLl9lbnN1cmVfY29ubmVjdGVkKChlcnIpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBkZWJ1ZygnZXhlY3V0aW5nIGRlZmluaXRpb24gcXVlcnk6ICVzIHdpdGggcGFyYW1zOiAlaicsIHF1ZXJ5LCBwYXJhbXMpO1xuICAgIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuICAgIGNvbnN0IGNvbm4gPSBwcm9wZXJ0aWVzLmRlZmluZV9jb25uZWN0aW9uO1xuICAgIGNvbm4uZXhlY3V0ZShxdWVyeSwgcGFyYW1zLCB7IHByZXBhcmU6IGZhbHNlLCBmZXRjaFNpemU6IDAgfSwgY2FsbGJhY2spO1xuICB9KTtcbn07XG5cbkJhc2VNb2RlbC5fZXhlY3V0ZV9iYXRjaCA9IGZ1bmN0aW9uIGYocXVlcmllcywgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgdGhpcy5fZW5zdXJlX2Nvbm5lY3RlZCgoZXJyKSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZGVidWcoJ2V4ZWN1dGluZyBiYXRjaCBxdWVyaWVzOiAlaicsIHF1ZXJpZXMpO1xuICAgIHRoaXMuX3Byb3BlcnRpZXMuY3FsLmJhdGNoKHF1ZXJpZXMsIG9wdGlvbnMsIGNhbGxiYWNrKTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuZXhlY3V0ZV9iYXRjaCA9IGZ1bmN0aW9uIGYocXVlcmllcywgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDIpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIHRoaXMuX2V4ZWN1dGVfYmF0Y2gocXVlcmllcywgb3B0aW9ucywgY2FsbGJhY2spO1xufTtcblxuQmFzZU1vZGVsLmdldF9jcWxfY2xpZW50ID0gZnVuY3Rpb24gZihjYWxsYmFjaykge1xuICB0aGlzLl9lbnN1cmVfY29ubmVjdGVkKChlcnIpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjYWxsYmFjayhudWxsLCB0aGlzLl9wcm9wZXJ0aWVzLmNxbCk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLl9jcmVhdGVfdGFibGUgPSBmdW5jdGlvbiBmKGNhbGxiYWNrKSB7XG4gIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuICBjb25zdCB0YWJsZU5hbWUgPSBwcm9wZXJ0aWVzLnRhYmxlX25hbWU7XG4gIGNvbnN0IG1vZGVsU2NoZW1hID0gcHJvcGVydGllcy5zY2hlbWE7XG4gIGNvbnN0IGRyb3BUYWJsZU9uU2NoZW1hQ2hhbmdlID0gcHJvcGVydGllcy5kcm9wVGFibGVPblNjaGVtYUNoYW5nZTtcbiAgbGV0IG1pZ3JhdGlvbiA9IHByb3BlcnRpZXMubWlncmF0aW9uO1xuXG4gIC8vIGJhY2t3YXJkcyBjb21wYXRpYmxlIGNoYW5nZSwgZHJvcFRhYmxlT25TY2hlbWFDaGFuZ2Ugd2lsbCB3b3JrIGxpa2UgbWlncmF0aW9uOiAnZHJvcCdcbiAgaWYgKCFtaWdyYXRpb24pIHtcbiAgICBpZiAoZHJvcFRhYmxlT25TY2hlbWFDaGFuZ2UpIG1pZ3JhdGlvbiA9ICdkcm9wJztcbiAgICBlbHNlIG1pZ3JhdGlvbiA9ICdzYWZlJztcbiAgfVxuICAvLyBhbHdheXMgc2FmZSBtaWdyYXRlIGlmIE5PREVfRU5WPT09J3Byb2R1Y3Rpb24nXG4gIGlmIChwcm9jZXNzLmVudi5OT0RFX0VOViA9PT0gJ3Byb2R1Y3Rpb24nKSBtaWdyYXRpb24gPSAnc2FmZSc7XG5cbiAgLy8gY2hlY2sgZm9yIGV4aXN0ZW5jZSBvZiB0YWJsZSBvbiBEQiBhbmQgaWYgaXQgbWF0Y2hlcyB0aGlzIG1vZGVsJ3Mgc2NoZW1hXG4gIHRoaXMuX2dldF9kYl90YWJsZV9zY2hlbWEoKGVyciwgZGJTY2hlbWEpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGFmdGVyQ3VzdG9tSW5kZXggPSAoZXJyMSkgPT4ge1xuICAgICAgaWYgKGVycjEpIHtcbiAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5kYmluZGV4Y3JlYXRlJywgZXJyMSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBtYXRlcmlhbGl6ZWQgdmlldyBjcmVhdGlvblxuICAgICAgaWYgKG1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cykge1xuICAgICAgICBhc3luYy5lYWNoU2VyaWVzKE9iamVjdC5rZXlzKG1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cyksICh2aWV3TmFtZSwgbmV4dCkgPT4ge1xuICAgICAgICAgIGNvbnN0IG1hdFZpZXdRdWVyeSA9IHRoaXMuX2NyZWF0ZV9tYXRlcmlhbGl6ZWRfdmlld19xdWVyeShcbiAgICAgICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgICAgIHZpZXdOYW1lLFxuICAgICAgICAgICAgbW9kZWxTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3ZpZXdOYW1lXSxcbiAgICAgICAgICApO1xuICAgICAgICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShtYXRWaWV3UXVlcnksIFtdLCAoZXJyMiwgcmVzdWx0KSA9PiB7XG4gICAgICAgICAgICBpZiAoZXJyMikgbmV4dChidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLm1hdHZpZXdjcmVhdGUnLCBlcnIyKSk7XG4gICAgICAgICAgICBlbHNlIG5leHQobnVsbCwgcmVzdWx0KTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSwgY2FsbGJhY2spO1xuICAgICAgfSBlbHNlIGNhbGxiYWNrKCk7XG4gICAgfTtcblxuICAgIGNvbnN0IGFmdGVyREJJbmRleCA9IChlcnIxKSA9PiB7XG4gICAgICBpZiAoZXJyMSkge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiaW5kZXhjcmVhdGUnLCBlcnIxKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIGN1c3RvbSBpbmRleCBjcmVhdGlvblxuICAgICAgaWYgKG1vZGVsU2NoZW1hLmN1c3RvbV9pbmRleGVzKSB7XG4gICAgICAgIGFzeW5jLmVhY2hTZXJpZXMobW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4ZXMsIChpZHgsIG5leHQpID0+IHtcbiAgICAgICAgICB0aGlzLl9leGVjdXRlX2RlZmluaXRpb25fcXVlcnkodGhpcy5fY3JlYXRlX2N1c3RvbV9pbmRleF9xdWVyeSh0YWJsZU5hbWUsIGlkeCksIFtdLCAoZXJyMiwgcmVzdWx0KSA9PiB7XG4gICAgICAgICAgICBpZiAoZXJyMikgbmV4dChlcnIyKTtcbiAgICAgICAgICAgIGVsc2UgbmV4dChudWxsLCByZXN1bHQpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9LCBhZnRlckN1c3RvbUluZGV4KTtcbiAgICAgIH0gZWxzZSBpZiAobW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4KSB7XG4gICAgICAgIGNvbnN0IGN1c3RvbUluZGV4UXVlcnkgPSB0aGlzLl9jcmVhdGVfY3VzdG9tX2luZGV4X3F1ZXJ5KHRhYmxlTmFtZSwgbW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4KTtcbiAgICAgICAgdGhpcy5fZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5KGN1c3RvbUluZGV4UXVlcnksIFtdLCAoZXJyMiwgcmVzdWx0KSA9PiB7XG4gICAgICAgICAgaWYgKGVycjIpIGFmdGVyQ3VzdG9tSW5kZXgoZXJyMik7XG4gICAgICAgICAgZWxzZSBhZnRlckN1c3RvbUluZGV4KG51bGwsIHJlc3VsdCk7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIGFmdGVyQ3VzdG9tSW5kZXgoKTtcbiAgICB9O1xuXG4gICAgY29uc3QgYWZ0ZXJEQkNyZWF0ZSA9IChlcnIxKSA9PiB7XG4gICAgICBpZiAoZXJyMSkge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiY3JlYXRlJywgZXJyMSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBpbmRleCBjcmVhdGlvblxuICAgICAgaWYgKG1vZGVsU2NoZW1hLmluZGV4ZXMgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgICAgICBhc3luYy5lYWNoU2VyaWVzKG1vZGVsU2NoZW1hLmluZGV4ZXMsIChpZHgsIG5leHQpID0+IHtcbiAgICAgICAgICB0aGlzLl9leGVjdXRlX2RlZmluaXRpb25fcXVlcnkodGhpcy5fY3JlYXRlX2luZGV4X3F1ZXJ5KHRhYmxlTmFtZSwgaWR4KSwgW10sIChlcnIyLCByZXN1bHQpID0+IHtcbiAgICAgICAgICAgIGlmIChlcnIyKSBuZXh0KGVycjIpO1xuICAgICAgICAgICAgZWxzZSBuZXh0KG51bGwsIHJlc3VsdCk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0sIGFmdGVyREJJbmRleCk7XG4gICAgICB9IGVsc2UgYWZ0ZXJEQkluZGV4KCk7XG4gICAgfTtcblxuICAgIGlmIChkYlNjaGVtYSkge1xuICAgICAgbGV0IG5vcm1hbGl6ZWRNb2RlbFNjaGVtYTtcbiAgICAgIGxldCBub3JtYWxpemVkREJTY2hlbWE7XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIG5vcm1hbGl6ZWRNb2RlbFNjaGVtYSA9IHNjaGVtZXIubm9ybWFsaXplX21vZGVsX3NjaGVtYShtb2RlbFNjaGVtYSk7XG4gICAgICAgIG5vcm1hbGl6ZWREQlNjaGVtYSA9IHNjaGVtZXIubm9ybWFsaXplX21vZGVsX3NjaGVtYShkYlNjaGVtYSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHNjaGVtYScsIGUubWVzc2FnZSkpO1xuICAgICAgfVxuXG4gICAgICBpZiAoXy5pc0VxdWFsKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYSwgbm9ybWFsaXplZERCU2NoZW1hKSkge1xuICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgZHJvcFJlY3JlYXRlVGFibGUgPSAoKSA9PiB7XG4gICAgICAgICAgY29uc3QgcGVybWlzc2lvbiA9IHRoaXMuX2Fza19jb25maXJtYXRpb24oXG4gICAgICAgICAgICB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgJ01pZ3JhdGlvbjogbW9kZWwgc2NoZW1hIGNoYW5nZWQgZm9yIHRhYmxlIFwiJXNcIiwgZHJvcCB0YWJsZSAmIHJlY3JlYXRlPyAoZGF0YSB3aWxsIGJlIGxvc3QhKSAoeS9uKTogJyxcbiAgICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApO1xuICAgICAgICAgIGlmIChwZXJtaXNzaW9uLnRvTG93ZXJDYXNlKCkgPT09ICd5Jykge1xuICAgICAgICAgICAgaWYgKG5vcm1hbGl6ZWREQlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3MpIHtcbiAgICAgICAgICAgICAgY29uc3QgbXZpZXdzID0gT2JqZWN0LmtleXMobm9ybWFsaXplZERCU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cyk7XG5cbiAgICAgICAgICAgICAgdGhpcy5kcm9wX212aWV3cyhtdmlld3MsIChlcnIxKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGVycjEpIHtcbiAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24ubWF0dmlld2Ryb3AnLCBlcnIxKSk7XG4gICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhpcy5kcm9wX3RhYmxlKChlcnIyKSA9PiB7XG4gICAgICAgICAgICAgICAgICBpZiAoZXJyMikge1xuICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiZHJvcCcsIGVycjIpKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgY29uc3QgY3JlYXRlVGFibGVRdWVyeSA9IHRoaXMuX2NyZWF0ZV90YWJsZV9xdWVyeSh0YWJsZU5hbWUsIG1vZGVsU2NoZW1hKTtcbiAgICAgICAgICAgICAgICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShjcmVhdGVUYWJsZVF1ZXJ5LCBbXSwgYWZ0ZXJEQkNyZWF0ZSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhpcy5kcm9wX3RhYmxlKChlcnIxKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGVycjEpIHtcbiAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJkcm9wJywgZXJyMSkpO1xuICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb25zdCBjcmVhdGVUYWJsZVF1ZXJ5ID0gdGhpcy5fY3JlYXRlX3RhYmxlX3F1ZXJ5KHRhYmxlTmFtZSwgbW9kZWxTY2hlbWEpO1xuICAgICAgICAgICAgICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShjcmVhdGVUYWJsZVF1ZXJ5LCBbXSwgYWZ0ZXJEQkNyZWF0ZSk7XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLnNjaGVtYW1pc21hdGNoJywgdGFibGVOYW1lKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9O1xuXG4gICAgICAgIGNvbnN0IGFmdGVyREJBbHRlciA9IChlcnIxKSA9PiB7XG4gICAgICAgICAgaWYgKGVycjEpIHtcbiAgICAgICAgICAgIGlmIChlcnIxLm1lc3NhZ2UgIT09ICdicmVhaycpIGNhbGxiYWNrKGVycjEpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBpdCBzaG91bGQgY3JlYXRlL2Ryb3AgaW5kZXhlcy9jdXN0b21faW5kZXhlcy9tYXRlcmlhbGl6ZWRfdmlld3MgdGhhdCBhcmUgYWRkZWQvcmVtb3ZlZCBpbiBtb2RlbCBzY2hlbWFcbiAgICAgICAgICAvLyByZW1vdmUgY29tbW9uIGluZGV4ZXMvY3VzdG9tX2luZGV4ZXMvbWF0ZXJpYWxpemVkX3ZpZXdzIGZyb20gbm9ybWFsaXplZE1vZGVsU2NoZW1hIGFuZCBub3JtYWxpemVkREJTY2hlbWFcbiAgICAgICAgICAvLyB0aGVuIGRyb3AgYWxsIHJlbWFpbmluZyBpbmRleGVzL2N1c3RvbV9pbmRleGVzL21hdGVyaWFsaXplZF92aWV3cyBmcm9tIG5vcm1hbGl6ZWREQlNjaGVtYVxuICAgICAgICAgIC8vIGFuZCBhZGQgYWxsIHJlbWFpbmluZyBpbmRleGVzL2N1c3RvbV9pbmRleGVzL21hdGVyaWFsaXplZF92aWV3cyBmcm9tIG5vcm1hbGl6ZWRNb2RlbFNjaGVtYVxuICAgICAgICAgIGNvbnN0IGFkZGVkSW5kZXhlcyA9IF8uZGlmZmVyZW5jZShub3JtYWxpemVkTW9kZWxTY2hlbWEuaW5kZXhlcywgbm9ybWFsaXplZERCU2NoZW1hLmluZGV4ZXMpO1xuICAgICAgICAgIGNvbnN0IHJlbW92ZWRJbmRleGVzID0gXy5kaWZmZXJlbmNlKG5vcm1hbGl6ZWREQlNjaGVtYS5pbmRleGVzLCBub3JtYWxpemVkTW9kZWxTY2hlbWEuaW5kZXhlcyk7XG4gICAgICAgICAgY29uc3QgcmVtb3ZlZEluZGV4TmFtZXMgPSBbXTtcbiAgICAgICAgICByZW1vdmVkSW5kZXhlcy5mb3JFYWNoKChyZW1vdmVkSW5kZXgpID0+IHtcbiAgICAgICAgICAgIHJlbW92ZWRJbmRleE5hbWVzLnB1c2goZGJTY2hlbWEuaW5kZXhfbmFtZXNbcmVtb3ZlZEluZGV4XSk7XG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgICBjb25zdCBhZGRlZEN1c3RvbUluZGV4ZXMgPSBfLmZpbHRlcihcbiAgICAgICAgICAgIG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5jdXN0b21faW5kZXhlcyxcbiAgICAgICAgICAgIChvYmopID0+ICghXy5maW5kKG5vcm1hbGl6ZWREQlNjaGVtYS5jdXN0b21faW5kZXhlcywgb2JqKSksXG4gICAgICAgICAgKTtcbiAgICAgICAgICBjb25zdCByZW1vdmVkQ3VzdG9tSW5kZXhlcyA9IF8uZmlsdGVyKFxuICAgICAgICAgICAgbm9ybWFsaXplZERCU2NoZW1hLmN1c3RvbV9pbmRleGVzLFxuICAgICAgICAgICAgKG9iaikgPT4gKCFfLmZpbmQobm9ybWFsaXplZE1vZGVsU2NoZW1hLmN1c3RvbV9pbmRleGVzLCBvYmopKSxcbiAgICAgICAgICApO1xuICAgICAgICAgIHJlbW92ZWRDdXN0b21JbmRleGVzLmZvckVhY2goKHJlbW92ZWRJbmRleCkgPT4ge1xuICAgICAgICAgICAgcmVtb3ZlZEluZGV4TmFtZXMucHVzaChkYlNjaGVtYS5pbmRleF9uYW1lc1tvYmplY3RIYXNoKHJlbW92ZWRJbmRleCldKTtcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIGNvbnN0IGFkZGVkTWF0ZXJpYWxpemVkVmlld3MgPSBfLmZpbHRlcihcbiAgICAgICAgICAgIE9iamVjdC5rZXlzKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3MpLFxuICAgICAgICAgICAgKHZpZXdOYW1lKSA9PlxuICAgICAgICAgICAgICAoIV8uZmluZChub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzLCBub3JtYWxpemVkTW9kZWxTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3ZpZXdOYW1lXSkpLFxuICAgICAgICAgICk7XG4gICAgICAgICAgY29uc3QgcmVtb3ZlZE1hdGVyaWFsaXplZFZpZXdzID0gXy5maWx0ZXIoXG4gICAgICAgICAgICBPYmplY3Qua2V5cyhub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzKSxcbiAgICAgICAgICAgICh2aWV3TmFtZSkgPT5cbiAgICAgICAgICAgICAgKCFfLmZpbmQobm9ybWFsaXplZE1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cywgbm9ybWFsaXplZERCU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1t2aWV3TmFtZV0pKSxcbiAgICAgICAgICApO1xuXG4gICAgICAgICAgLy8gcmVtb3ZlIGFsdGVyZWQgbWF0ZXJpYWxpemVkIHZpZXdzXG4gICAgICAgICAgaWYgKHJlbW92ZWRNYXRlcmlhbGl6ZWRWaWV3cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gdGhpcy5fYXNrX2NvbmZpcm1hdGlvbihcbiAgICAgICAgICAgICAgdXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICAgJ01pZ3JhdGlvbjogbW9kZWwgc2NoZW1hIGZvciB0YWJsZSBcIiVzXCIgaGFzIHJlbW92ZWQgbWF0ZXJpYWxpemVkX3ZpZXdzOiAlaiwgZHJvcCB0aGVtPyAoeS9uKTogJyxcbiAgICAgICAgICAgICAgICB0YWJsZU5hbWUsXG4gICAgICAgICAgICAgICAgcmVtb3ZlZE1hdGVyaWFsaXplZFZpZXdzLFxuICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmIChwZXJtaXNzaW9uLnRvTG93ZXJDYXNlKCkgIT09ICd5Jykge1xuICAgICAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLnNjaGVtYW1pc21hdGNoJywgdGFibGVOYW1lKSk7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlbW92ZWRJbmRleE5hbWVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGNvbnN0IHBlcm1pc3Npb24gPSB0aGlzLl9hc2tfY29uZmlybWF0aW9uKFxuICAgICAgICAgICAgICB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAnTWlncmF0aW9uOiBtb2RlbCBzY2hlbWEgZm9yIHRhYmxlIFwiJXNcIiBoYXMgcmVtb3ZlZCBpbmRleGVzOiAlaiwgZHJvcCB0aGVtPyAoeS9uKTogJyxcbiAgICAgICAgICAgICAgICB0YWJsZU5hbWUsXG4gICAgICAgICAgICAgICAgcmVtb3ZlZEluZGV4TmFtZXMsXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKHBlcm1pc3Npb24udG9Mb3dlckNhc2UoKSAhPT0gJ3knKSB7XG4gICAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uc2NoZW1hbWlzbWF0Y2gnLCB0YWJsZU5hbWUpKTtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIHRoaXMuZHJvcF9tdmlld3MocmVtb3ZlZE1hdGVyaWFsaXplZFZpZXdzLCAoZXJyMikgPT4ge1xuICAgICAgICAgICAgaWYgKGVycjIpIHtcbiAgICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5tYXR2aWV3ZHJvcCcsIGVycjIpKTtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyByZW1vdmUgYWx0ZXJlZCBpbmRleGVzIGJ5IGluZGV4IG5hbWVcbiAgICAgICAgICAgIHRoaXMuZHJvcF9pbmRleGVzKHJlbW92ZWRJbmRleE5hbWVzLCAoZXJyMykgPT4ge1xuICAgICAgICAgICAgICBpZiAoZXJyMykge1xuICAgICAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJpbmRleGRyb3AnLCBlcnIzKSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgLy8gYWRkIGFsdGVyZWQgaW5kZXhlc1xuICAgICAgICAgICAgICBhc3luYy5lYWNoU2VyaWVzKGFkZGVkSW5kZXhlcywgKGlkeCwgbmV4dCkgPT4ge1xuICAgICAgICAgICAgICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeSh0aGlzLl9jcmVhdGVfaW5kZXhfcXVlcnkodGFibGVOYW1lLCBpZHgpLCBbXSwgKGVycjQsIHJlc3VsdCkgPT4ge1xuICAgICAgICAgICAgICAgICAgaWYgKGVycjQpIG5leHQoZXJyNCk7XG4gICAgICAgICAgICAgICAgICBlbHNlIG5leHQobnVsbCwgcmVzdWx0KTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgfSwgKGVycjQpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZXJyNCkge1xuICAgICAgICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5kYmluZGV4Y3JlYXRlJywgZXJyNCkpO1xuICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vIGFkZCBhbHRlcmVkIGN1c3RvbSBpbmRleGVzXG4gICAgICAgICAgICAgICAgYXN5bmMuZWFjaFNlcmllcyhhZGRlZEN1c3RvbUluZGV4ZXMsIChpZHgsIG5leHQpID0+IHtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGN1c3RvbUluZGV4UXVlcnkgPSB0aGlzLl9jcmVhdGVfY3VzdG9tX2luZGV4X3F1ZXJ5KHRhYmxlTmFtZSwgaWR4KTtcbiAgICAgICAgICAgICAgICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShjdXN0b21JbmRleFF1ZXJ5LCBbXSwgKGVycjUsIHJlc3VsdCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZXJyNSkgbmV4dChlcnI1KTtcbiAgICAgICAgICAgICAgICAgICAgZWxzZSBuZXh0KG51bGwsIHJlc3VsdCk7XG4gICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9LCAoZXJyNSkgPT4ge1xuICAgICAgICAgICAgICAgICAgaWYgKGVycjUpIHtcbiAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5kYmluZGV4Y3JlYXRlJywgZXJyNSkpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgIC8vIGFkZCBhbHRlcmVkIG1hdGVyaWFsaXplZF92aWV3c1xuICAgICAgICAgICAgICAgICAgYXN5bmMuZWFjaFNlcmllcyhhZGRlZE1hdGVyaWFsaXplZFZpZXdzLCAodmlld05hbWUsIG5leHQpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbWF0Vmlld1F1ZXJ5ID0gdGhpcy5fY3JlYXRlX21hdGVyaWFsaXplZF92aWV3X3F1ZXJ5KFxuICAgICAgICAgICAgICAgICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICB2aWV3TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICBtb2RlbFNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbdmlld05hbWVdLFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9leGVjdXRlX2RlZmluaXRpb25fcXVlcnkobWF0Vmlld1F1ZXJ5LCBbXSwgKGVycjYsIHJlc3VsdCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgIGlmIChlcnI2KSBuZXh0KGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24ubWF0dmlld2NyZWF0ZScsIGVycjYpKTtcbiAgICAgICAgICAgICAgICAgICAgICBlbHNlIG5leHQobnVsbCwgcmVzdWx0KTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICB9LCBjYWxsYmFjayk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH07XG5cbiAgICAgICAgY29uc3QgYWx0ZXJEQlRhYmxlID0gKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IGRpZmZlcmVuY2VzID0gZGVlcERpZmYobm9ybWFsaXplZERCU2NoZW1hLmZpZWxkcywgbm9ybWFsaXplZE1vZGVsU2NoZW1hLmZpZWxkcyk7XG4gICAgICAgICAgYXN5bmMuZWFjaFNlcmllcyhkaWZmZXJlbmNlcywgKGRpZmYsIG5leHQpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGZpZWxkTmFtZSA9IGRpZmYucGF0aFswXTtcbiAgICAgICAgICAgIGNvbnN0IGFsdGVyRmllbGRUeXBlID0gKCkgPT4ge1xuICAgICAgICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gdGhpcy5fYXNrX2NvbmZpcm1hdGlvbihcbiAgICAgICAgICAgICAgICB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAgICdNaWdyYXRpb246IG1vZGVsIHNjaGVtYSBmb3IgdGFibGUgXCIlc1wiIGhhcyBuZXcgdHlwZSBmb3IgZmllbGQgXCIlc1wiLCAnICtcbiAgICAgICAgICAgICAgICAgICdhbHRlciB0YWJsZSB0byB1cGRhdGUgY29sdW1uIHR5cGU/ICh5L24pOiAnLFxuICAgICAgICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIGlmIChwZXJtaXNzaW9uLnRvTG93ZXJDYXNlKCkgPT09ICd5Jykge1xuICAgICAgICAgICAgICAgIHRoaXMuYWx0ZXJfdGFibGUoJ0FMVEVSJywgZmllbGROYW1lLCBkaWZmLnJocywgKGVycjEsIHJlc3VsdCkgPT4ge1xuICAgICAgICAgICAgICAgICAgaWYgKGVycjEpIG5leHQoYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5kYmFsdGVyJywgZXJyMSkpO1xuICAgICAgICAgICAgICAgICAgZWxzZSBuZXh0KG51bGwsIHJlc3VsdCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgbmV4dChidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLnNjaGVtYW1pc21hdGNoJywgdGFibGVOYW1lKSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIGNvbnN0IGFsdGVyQWRkRmllbGQgPSAoKSA9PiB7XG4gICAgICAgICAgICAgIGxldCB0eXBlID0gJyc7XG4gICAgICAgICAgICAgIGlmIChkaWZmLnBhdGgubGVuZ3RoID4gMSkge1xuICAgICAgICAgICAgICAgIGlmIChkaWZmLnBhdGhbMV0gPT09ICd0eXBlJykge1xuICAgICAgICAgICAgICAgICAgdHlwZSA9IGRpZmYucmhzO1xuICAgICAgICAgICAgICAgICAgaWYgKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlRGVmKSB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGUgKz0gbm9ybWFsaXplZE1vZGVsU2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGVEZWY7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHR5cGUgPSBub3JtYWxpemVkTW9kZWxTY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZTtcbiAgICAgICAgICAgICAgICAgIHR5cGUgKz0gZGlmZi5yaHM7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBkaWZmLnJocy50eXBlO1xuICAgICAgICAgICAgICAgIGlmIChkaWZmLnJocy50eXBlRGVmKSB0eXBlICs9IGRpZmYucmhzLnR5cGVEZWY7XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICB0aGlzLmFsdGVyX3RhYmxlKCdBREQnLCBmaWVsZE5hbWUsIHR5cGUsIChlcnIxLCByZXN1bHQpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZXJyMSkgbmV4dChidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiYWx0ZXInLCBlcnIxKSk7XG4gICAgICAgICAgICAgICAgZWxzZSBuZXh0KG51bGwsIHJlc3VsdCk7XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgY29uc3QgYWx0ZXJSZW1vdmVGaWVsZCA9IChuZXh0Q2FsbGJhY2spID0+IHtcbiAgICAgICAgICAgICAgLy8gcmVtb3ZlIGRlcGVuZGVudCBpbmRleGVzL2N1c3RvbV9pbmRleGVzL21hdGVyaWFsaXplZF92aWV3cyxcbiAgICAgICAgICAgICAgLy8gdXBkYXRlIHRoZW0gaW4gbm9ybWFsaXplZERCU2NoZW1hLCB0aGVuIGFsdGVyXG4gICAgICAgICAgICAgIGNvbnN0IGRlcGVuZGVudEluZGV4ZXMgPSBbXTtcbiAgICAgICAgICAgICAgY29uc3QgcHVsbEluZGV4ZXMgPSBbXTtcbiAgICAgICAgICAgICAgbm9ybWFsaXplZERCU2NoZW1hLmluZGV4ZXMuZm9yRWFjaCgoZGJJbmRleCkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGluZGV4U3BsaXQgPSBkYkluZGV4LnNwbGl0KC9bKCldL2cpO1xuICAgICAgICAgICAgICAgIGxldCBpbmRleEZpZWxkTmFtZSA9ICcnO1xuICAgICAgICAgICAgICAgIGlmIChpbmRleFNwbGl0Lmxlbmd0aCA+IDEpIGluZGV4RmllbGROYW1lID0gaW5kZXhTcGxpdFsxXTtcbiAgICAgICAgICAgICAgICBlbHNlIGluZGV4RmllbGROYW1lID0gaW5kZXhTcGxpdFswXTtcbiAgICAgICAgICAgICAgICBpZiAoaW5kZXhGaWVsZE5hbWUgPT09IGZpZWxkTmFtZSkge1xuICAgICAgICAgICAgICAgICAgZGVwZW5kZW50SW5kZXhlcy5wdXNoKGRiU2NoZW1hLmluZGV4X25hbWVzW2RiSW5kZXhdKTtcbiAgICAgICAgICAgICAgICAgIHB1bGxJbmRleGVzLnB1c2goZGJJbmRleCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgXy5wdWxsQWxsKG5vcm1hbGl6ZWREQlNjaGVtYS5pbmRleGVzLCBwdWxsSW5kZXhlcyk7XG5cbiAgICAgICAgICAgICAgY29uc3QgcHVsbEN1c3RvbUluZGV4ZXMgPSBbXTtcbiAgICAgICAgICAgICAgbm9ybWFsaXplZERCU2NoZW1hLmN1c3RvbV9pbmRleGVzLmZvckVhY2goKGRiSW5kZXgpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZGJJbmRleC5vbiA9PT0gZmllbGROYW1lKSB7XG4gICAgICAgICAgICAgICAgICBkZXBlbmRlbnRJbmRleGVzLnB1c2goZGJTY2hlbWEuaW5kZXhfbmFtZXNbb2JqZWN0SGFzaChkYkluZGV4KV0pO1xuICAgICAgICAgICAgICAgICAgcHVsbEN1c3RvbUluZGV4ZXMucHVzaChkYkluZGV4KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICBfLnB1bGxBbGwobm9ybWFsaXplZERCU2NoZW1hLmN1c3RvbV9pbmRleGVzLCBwdWxsQ3VzdG9tSW5kZXhlcyk7XG5cbiAgICAgICAgICAgICAgY29uc3QgZGVwZW5kZW50Vmlld3MgPSBbXTtcbiAgICAgICAgICAgICAgT2JqZWN0LmtleXMobm9ybWFsaXplZERCU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cykuZm9yRWFjaCgoZGJWaWV3TmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW2RiVmlld05hbWVdLnNlbGVjdC5pbmRleE9mKGZpZWxkTmFtZSkgPiAtMSkge1xuICAgICAgICAgICAgICAgICAgZGVwZW5kZW50Vmlld3MucHVzaChkYlZpZXdOYW1lKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKG5vcm1hbGl6ZWREQlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3NbZGJWaWV3TmFtZV0uc2VsZWN0WzBdID09PSAnKicpIHtcbiAgICAgICAgICAgICAgICAgIGRlcGVuZGVudFZpZXdzLnB1c2goZGJWaWV3TmFtZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW2RiVmlld05hbWVdLmtleS5pbmRleE9mKGZpZWxkTmFtZSkgPiAtMSkge1xuICAgICAgICAgICAgICAgICAgZGVwZW5kZW50Vmlld3MucHVzaChkYlZpZXdOYW1lKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKG5vcm1hbGl6ZWREQlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3NbZGJWaWV3TmFtZV0ua2V5WzBdIGluc3RhbmNlb2YgQXJyYXlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAmJiBub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW2RiVmlld05hbWVdLmtleVswXS5pbmRleE9mKGZpZWxkTmFtZSkgPiAtMSkge1xuICAgICAgICAgICAgICAgICAgZGVwZW5kZW50Vmlld3MucHVzaChkYlZpZXdOYW1lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICBkZXBlbmRlbnRWaWV3cy5mb3JFYWNoKCh2aWV3TmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3ZpZXdOYW1lXTtcbiAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgdGhpcy5kcm9wX212aWV3cyhkZXBlbmRlbnRWaWV3cywgKGVycjEpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZXJyMSkge1xuICAgICAgICAgICAgICAgICAgbmV4dENhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24ubWF0dmlld2Ryb3AnLCBlcnIxKSk7XG4gICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhpcy5kcm9wX2luZGV4ZXMoZGVwZW5kZW50SW5kZXhlcywgKGVycjIpID0+IHtcbiAgICAgICAgICAgICAgICAgIGlmIChlcnIyKSB7XG4gICAgICAgICAgICAgICAgICAgIG5leHRDYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiaW5kZXhkcm9wJywgZXJyMikpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgIHRoaXMuYWx0ZXJfdGFibGUoJ0RST1AnLCBmaWVsZE5hbWUsICcnLCAoZXJyMywgcmVzdWx0KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChlcnIzKSBuZXh0Q2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5kYmFsdGVyJywgZXJyMykpO1xuICAgICAgICAgICAgICAgICAgICBlbHNlIG5leHRDYWxsYmFjayhudWxsLCByZXN1bHQpO1xuICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgaWYgKGRpZmYua2luZCA9PT0gJ04nKSB7XG4gICAgICAgICAgICAgIGNvbnN0IHBlcm1pc3Npb24gPSB0aGlzLl9hc2tfY29uZmlybWF0aW9uKFxuICAgICAgICAgICAgICAgIHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgJ01pZ3JhdGlvbjogbW9kZWwgc2NoZW1hIGZvciB0YWJsZSBcIiVzXCIgaGFzIGFkZGVkIGZpZWxkIFwiJXNcIiwgYWx0ZXIgdGFibGUgdG8gYWRkIGNvbHVtbj8gKHkvbik6ICcsXG4gICAgICAgICAgICAgICAgICB0YWJsZU5hbWUsXG4gICAgICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgaWYgKHBlcm1pc3Npb24udG9Mb3dlckNhc2UoKSA9PT0gJ3knKSB7XG4gICAgICAgICAgICAgICAgYWx0ZXJBZGRGaWVsZCgpO1xuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG5leHQoYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5zY2hlbWFtaXNtYXRjaCcsIHRhYmxlTmFtZSkpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGRpZmYua2luZCA9PT0gJ0QnKSB7XG4gICAgICAgICAgICAgIGNvbnN0IHBlcm1pc3Npb24gPSB0aGlzLl9hc2tfY29uZmlybWF0aW9uKFxuICAgICAgICAgICAgICAgIHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgJ01pZ3JhdGlvbjogbW9kZWwgc2NoZW1hIGZvciB0YWJsZSBcIiVzXCIgaGFzIHJlbW92ZWQgZmllbGQgXCIlc1wiLCBhbHRlciB0YWJsZSB0byBkcm9wIGNvbHVtbj8gJyArXG4gICAgICAgICAgICAgICAgICAnKGNvbHVtbiBkYXRhIHdpbGwgYmUgbG9zdCAmIGRlcGVuZGVudCBpbmRleGVzL3ZpZXdzIHdpbGwgYmUgcmVjcmVhdGVkISkgKHkvbik6ICcsXG4gICAgICAgICAgICAgICAgICB0YWJsZU5hbWUsXG4gICAgICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgaWYgKHBlcm1pc3Npb24udG9Mb3dlckNhc2UoKSA9PT0gJ3knKSB7XG4gICAgICAgICAgICAgICAgYWx0ZXJSZW1vdmVGaWVsZChuZXh0KTtcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBuZXh0KGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uc2NoZW1hbWlzbWF0Y2gnLCB0YWJsZU5hbWUpKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChkaWZmLmtpbmQgPT09ICdFJykge1xuICAgICAgICAgICAgICAvLyBjaGVjayBpZiB0aGUgYWx0ZXIgZmllbGQgdHlwZSBpcyBwb3NzaWJsZSwgb3RoZXJ3aXNlIHRyeSBEIGFuZCB0aGVuIE5cbiAgICAgICAgICAgICAgaWYgKGRpZmYucGF0aFsxXSA9PT0gJ3R5cGUnKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRpZmYubGhzID09PSAnaW50JyAmJiBkaWZmLnJocyA9PT0gJ3ZhcmludCcpIHtcbiAgICAgICAgICAgICAgICAgIC8vIGFsdGVyIGZpZWxkIHR5cGUgcG9zc2libGVcbiAgICAgICAgICAgICAgICAgIGFsdGVyRmllbGRUeXBlKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChub3JtYWxpemVkREJTY2hlbWEua2V5LmluZGV4T2YoZmllbGROYW1lKSA+IDApIHsgLy8gY2hlY2sgaWYgZmllbGQgcGFydCBvZiBjbHVzdGVyaW5nIGtleVxuICAgICAgICAgICAgICAgICAgLy8gYWx0ZXIgZmllbGQgdHlwZSBpbXBvc3NpYmxlXG4gICAgICAgICAgICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gdGhpcy5fYXNrX2NvbmZpcm1hdGlvbihcbiAgICAgICAgICAgICAgICAgICAgdXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICAgICAgICAgJ01pZ3JhdGlvbjogbW9kZWwgc2NoZW1hIGZvciB0YWJsZSBcIiVzXCIgaGFzIG5ldyBpbmNvbXBhdGlibGUgdHlwZSBmb3IgcHJpbWFyeSBrZXkgZmllbGQgXCIlc1wiLCAnICtcbiAgICAgICAgICAgICAgICAgICAgICAncHJvY2VlZCB0byByZWNyZWF0ZSB0YWJsZT8gKHkvbik6ICcsXG4gICAgICAgICAgICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICBpZiAocGVybWlzc2lvbi50b0xvd2VyQ2FzZSgpID09PSAneScpIHtcbiAgICAgICAgICAgICAgICAgICAgZHJvcFJlY3JlYXRlVGFibGUoKTtcbiAgICAgICAgICAgICAgICAgICAgbmV4dChuZXcgRXJyb3IoJ2JyZWFrJykpO1xuICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbmV4dChidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLnNjaGVtYW1pc21hdGNoJywgdGFibGVOYW1lKSk7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChbJ3RleHQnLCAnYXNjaWknLCAnYmlnaW50JywgJ2Jvb2xlYW4nLCAnZGVjaW1hbCcsXG4gICAgICAgICAgICAgICAgICAnZG91YmxlJywgJ2Zsb2F0JywgJ2luZXQnLCAnaW50JywgJ3RpbWVzdGFtcCcsICd0aW1ldXVpZCcsXG4gICAgICAgICAgICAgICAgICAndXVpZCcsICd2YXJjaGFyJywgJ3ZhcmludCddLmluZGV4T2YoZGlmZi5saHMpID4gLTEgJiYgZGlmZi5yaHMgPT09ICdibG9iJykge1xuICAgICAgICAgICAgICAgICAgLy8gYWx0ZXIgZmllbGQgdHlwZSBwb3NzaWJsZVxuICAgICAgICAgICAgICAgICAgYWx0ZXJGaWVsZFR5cGUoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGRpZmYubGhzID09PSAndGltZXV1aWQnICYmIGRpZmYucmhzID09PSAndXVpZCcpIHtcbiAgICAgICAgICAgICAgICAgIC8vIGFsdGVyIGZpZWxkIHR5cGUgcG9zc2libGVcbiAgICAgICAgICAgICAgICAgIGFsdGVyRmllbGRUeXBlKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChub3JtYWxpemVkREJTY2hlbWEua2V5WzBdLmluZGV4T2YoZmllbGROYW1lKSA+IC0xKSB7IC8vIGNoZWNrIGlmIGZpZWxkIHBhcnQgb2YgcGFydGl0aW9uIGtleVxuICAgICAgICAgICAgICAgICAgLy8gYWx0ZXIgZmllbGQgdHlwZSBpbXBvc3NpYmxlXG4gICAgICAgICAgICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gdGhpcy5fYXNrX2NvbmZpcm1hdGlvbihcbiAgICAgICAgICAgICAgICAgICAgdXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICAgICAgICAgJ01pZ3JhdGlvbjogbW9kZWwgc2NoZW1hIGZvciB0YWJsZSBcIiVzXCIgaGFzIG5ldyBpbmNvbXBhdGlibGUgdHlwZSBmb3IgcHJpbWFyeSBrZXkgZmllbGQgXCIlc1wiLCAnICtcbiAgICAgICAgICAgICAgICAgICAgICAncHJvY2VlZCB0byByZWNyZWF0ZSB0YWJsZT8gKHkvbik6ICcsXG4gICAgICAgICAgICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICBpZiAocGVybWlzc2lvbi50b0xvd2VyQ2FzZSgpID09PSAneScpIHtcbiAgICAgICAgICAgICAgICAgICAgZHJvcFJlY3JlYXRlVGFibGUoKTtcbiAgICAgICAgICAgICAgICAgICAgbmV4dChuZXcgRXJyb3IoJ2JyZWFrJykpO1xuICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbmV4dChidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLnNjaGVtYW1pc21hdGNoJywgdGFibGVOYW1lKSk7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIC8vIGFsdGVyIHR5cGUgaW1wb3NzaWJsZVxuICAgICAgICAgICAgICAgICAgY29uc3QgcGVybWlzc2lvbiA9IHRoaXMuX2Fza19jb25maXJtYXRpb24oXG4gICAgICAgICAgICAgICAgICAgIHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgICAgICdNaWdyYXRpb246IG1vZGVsIHNjaGVtYSBmb3IgdGFibGUgXCIlc1wiIGhhcyBuZXcgaW5jb21wYXRpYmxlIHR5cGUgZm9yIGZpZWxkIFwiJXNcIiwgZHJvcCBjb2x1bW4gJyArXG4gICAgICAgICAgICAgICAgICAgICAgJ2FuZCByZWNyZWF0ZT8gKGNvbHVtbiBkYXRhIHdpbGwgYmUgbG9zdCAmIGRlcGVuZGVudCBpbmRleGVzL3ZpZXdzIHdpbGwgYmUgcmVjcmVhdGVkISkgKHkvbik6ICcsXG4gICAgICAgICAgICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICBpZiAocGVybWlzc2lvbi50b0xvd2VyQ2FzZSgpID09PSAneScpIHtcbiAgICAgICAgICAgICAgICAgICAgYWx0ZXJSZW1vdmVGaWVsZCgoZXJyMSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgIGlmIChlcnIxKSBuZXh0KGVycjEpO1xuICAgICAgICAgICAgICAgICAgICAgIGVsc2UgYWx0ZXJBZGRGaWVsZCgpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIG5leHQoYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5zY2hlbWFtaXNtYXRjaCcsIHRhYmxlTmFtZSkpO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBhbHRlciB0eXBlIGltcG9zc2libGVcbiAgICAgICAgICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gdGhpcy5fYXNrX2NvbmZpcm1hdGlvbihcbiAgICAgICAgICAgICAgICAgIHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgICAnTWlncmF0aW9uOiBtb2RlbCBzY2hlbWEgZm9yIHRhYmxlIFwiJXNcIiBoYXMgbmV3IGluY29tcGF0aWJsZSB0eXBlIGZvciBmaWVsZCBcIiVzXCIsIGRyb3AgY29sdW1uICcgK1xuICAgICAgICAgICAgICAgICAgICAnYW5kIHJlY3JlYXRlPyAoY29sdW1uIGRhdGEgd2lsbCBiZSBsb3N0ICYgZGVwZW5kZW50IGluZGV4ZXMvdmlld3Mgd2lsbCBiZSByZWNyZWF0ZWQhKSAoeS9uKTogJyxcbiAgICAgICAgICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgaWYgKHBlcm1pc3Npb24udG9Mb3dlckNhc2UoKSA9PT0gJ3knKSB7XG4gICAgICAgICAgICAgICAgICBhbHRlclJlbW92ZUZpZWxkKChlcnIxKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChlcnIxKSBuZXh0KGVycjEpO1xuICAgICAgICAgICAgICAgICAgICBlbHNlIGFsdGVyQWRkRmllbGQoKTtcbiAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICBuZXh0KGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uc2NoZW1hbWlzbWF0Y2gnLCB0YWJsZU5hbWUpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIG5leHQoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9LCBhZnRlckRCQWx0ZXIpO1xuICAgICAgICB9O1xuXG4gICAgICAgIGlmIChtaWdyYXRpb24gPT09ICdhbHRlcicpIHtcbiAgICAgICAgICAvLyBjaGVjayBpZiB0YWJsZSBjYW4gYmUgYWx0ZXJlZCB0byBtYXRjaCBzY2hlbWFcbiAgICAgICAgICBpZiAoXy5pc0VxdWFsKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5rZXksIG5vcm1hbGl6ZWREQlNjaGVtYS5rZXkpICYmXG4gICAgICAgICAgICBfLmlzRXF1YWwobm9ybWFsaXplZE1vZGVsU2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXIsIG5vcm1hbGl6ZWREQlNjaGVtYS5jbHVzdGVyaW5nX29yZGVyKSkge1xuICAgICAgICAgICAgYWx0ZXJEQlRhYmxlKCk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGRyb3BSZWNyZWF0ZVRhYmxlKCk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKG1pZ3JhdGlvbiA9PT0gJ2Ryb3AnKSB7XG4gICAgICAgICAgZHJvcFJlY3JlYXRlVGFibGUoKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLnNjaGVtYW1pc21hdGNoJywgdGFibGVOYW1lKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gaWYgbm90IGV4aXN0aW5nLCBpdCdzIGNyZWF0ZWRcbiAgICAgIGNvbnN0IGNyZWF0ZVRhYmxlUXVlcnkgPSB0aGlzLl9jcmVhdGVfdGFibGVfcXVlcnkodGFibGVOYW1lLCBtb2RlbFNjaGVtYSk7XG4gICAgICB0aGlzLl9leGVjdXRlX2RlZmluaXRpb25fcXVlcnkoY3JlYXRlVGFibGVRdWVyeSwgW10sIGFmdGVyREJDcmVhdGUpO1xuICAgIH1cbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuX2NyZWF0ZV90YWJsZV9xdWVyeSA9IGZ1bmN0aW9uIGYodGFibGVOYW1lLCBzY2hlbWEpIHtcbiAgY29uc3Qgcm93cyA9IFtdO1xuICBsZXQgZmllbGRUeXBlO1xuICBPYmplY3Qua2V5cyhzY2hlbWEuZmllbGRzKS5mb3JFYWNoKChrKSA9PiB7XG4gICAgaWYgKHNjaGVtYS5maWVsZHNba10udmlydHVhbCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBsZXQgc2VnbWVudCA9ICcnO1xuICAgIGZpZWxkVHlwZSA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUoc2NoZW1hLCBrKTtcbiAgICBpZiAoc2NoZW1hLmZpZWxkc1trXS50eXBlRGVmKSB7XG4gICAgICBzZWdtZW50ID0gdXRpbC5mb3JtYXQoJ1wiJXNcIiAlcyVzJywgaywgZmllbGRUeXBlLCBzY2hlbWEuZmllbGRzW2tdLnR5cGVEZWYpO1xuICAgIH0gZWxzZSB7XG4gICAgICBzZWdtZW50ID0gdXRpbC5mb3JtYXQoJ1wiJXNcIiAlcycsIGssIGZpZWxkVHlwZSk7XG4gICAgfVxuXG4gICAgaWYgKHNjaGVtYS5maWVsZHNba10uc3RhdGljKSB7XG4gICAgICBzZWdtZW50ICs9ICcgU1RBVElDJztcbiAgICB9XG5cbiAgICByb3dzLnB1c2goc2VnbWVudCk7XG4gIH0pO1xuXG4gIGxldCBwYXJ0aXRpb25LZXkgPSBzY2hlbWEua2V5WzBdO1xuICBsZXQgY2x1c3RlcmluZ0tleSA9IHNjaGVtYS5rZXkuc2xpY2UoMSwgc2NoZW1hLmtleS5sZW5ndGgpO1xuICBjb25zdCBjbHVzdGVyaW5nT3JkZXIgPSBbXTtcblxuXG4gIGZvciAobGV0IGZpZWxkID0gMDsgZmllbGQgPCBjbHVzdGVyaW5nS2V5Lmxlbmd0aDsgZmllbGQrKykge1xuICAgIGlmIChzY2hlbWEuY2x1c3RlcmluZ19vcmRlclxuICAgICAgICAmJiBzY2hlbWEuY2x1c3RlcmluZ19vcmRlcltjbHVzdGVyaW5nS2V5W2ZpZWxkXV1cbiAgICAgICAgJiYgc2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJbY2x1c3RlcmluZ0tleVtmaWVsZF1dLnRvTG93ZXJDYXNlKCkgPT09ICdkZXNjJykge1xuICAgICAgY2x1c3RlcmluZ09yZGVyLnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIiBERVNDJywgY2x1c3RlcmluZ0tleVtmaWVsZF0pKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2x1c3RlcmluZ09yZGVyLnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIiBBU0MnLCBjbHVzdGVyaW5nS2V5W2ZpZWxkXSkpO1xuICAgIH1cbiAgfVxuXG4gIGxldCBjbHVzdGVyaW5nT3JkZXJRdWVyeSA9ICcnO1xuICBpZiAoY2x1c3RlcmluZ09yZGVyLmxlbmd0aCA+IDApIHtcbiAgICBjbHVzdGVyaW5nT3JkZXJRdWVyeSA9IHV0aWwuZm9ybWF0KCcgV0lUSCBDTFVTVEVSSU5HIE9SREVSIEJZICglcyknLCBjbHVzdGVyaW5nT3JkZXIudG9TdHJpbmcoKSk7XG4gIH1cblxuICBpZiAocGFydGl0aW9uS2V5IGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICBwYXJ0aXRpb25LZXkgPSBwYXJ0aXRpb25LZXkubWFwKCh2KSA9PiAodXRpbC5mb3JtYXQoJ1wiJXNcIicsIHYpKSkuam9pbignLCcpO1xuICB9IGVsc2Uge1xuICAgIHBhcnRpdGlvbktleSA9IHV0aWwuZm9ybWF0KCdcIiVzXCInLCBwYXJ0aXRpb25LZXkpO1xuICB9XG5cbiAgaWYgKGNsdXN0ZXJpbmdLZXkubGVuZ3RoKSB7XG4gICAgY2x1c3RlcmluZ0tleSA9IGNsdXN0ZXJpbmdLZXkubWFwKCh2KSA9PiAodXRpbC5mb3JtYXQoJ1wiJXNcIicsIHYpKSkuam9pbignLCcpO1xuICAgIGNsdXN0ZXJpbmdLZXkgPSB1dGlsLmZvcm1hdCgnLCVzJywgY2x1c3RlcmluZ0tleSk7XG4gIH0gZWxzZSB7XG4gICAgY2x1c3RlcmluZ0tleSA9ICcnO1xuICB9XG5cbiAgY29uc3QgcXVlcnkgPSB1dGlsLmZvcm1hdChcbiAgICAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgXCIlc1wiICglcyAsIFBSSU1BUlkgS0VZKCglcyklcykpJXM7JyxcbiAgICB0YWJsZU5hbWUsXG4gICAgcm93cy5qb2luKCcgLCAnKSxcbiAgICBwYXJ0aXRpb25LZXksXG4gICAgY2x1c3RlcmluZ0tleSxcbiAgICBjbHVzdGVyaW5nT3JkZXJRdWVyeSxcbiAgKTtcblxuICByZXR1cm4gcXVlcnk7XG59O1xuXG5CYXNlTW9kZWwuX2NyZWF0ZV9tYXRlcmlhbGl6ZWRfdmlld19xdWVyeSA9IGZ1bmN0aW9uIGYodGFibGVOYW1lLCB2aWV3TmFtZSwgdmlld1NjaGVtYSkge1xuICBjb25zdCByb3dzID0gW107XG5cbiAgZm9yIChsZXQgayA9IDA7IGsgPCB2aWV3U2NoZW1hLnNlbGVjdC5sZW5ndGg7IGsrKykge1xuICAgIGlmICh2aWV3U2NoZW1hLnNlbGVjdFtrXSA9PT0gJyonKSByb3dzLnB1c2godXRpbC5mb3JtYXQoJyVzJywgdmlld1NjaGVtYS5zZWxlY3Rba10pKTtcbiAgICBlbHNlIHJvd3MucHVzaCh1dGlsLmZvcm1hdCgnXCIlc1wiJywgdmlld1NjaGVtYS5zZWxlY3Rba10pKTtcbiAgfVxuXG4gIGxldCBwYXJ0aXRpb25LZXkgPSB2aWV3U2NoZW1hLmtleVswXTtcbiAgbGV0IGNsdXN0ZXJpbmdLZXkgPSB2aWV3U2NoZW1hLmtleS5zbGljZSgxLCB2aWV3U2NoZW1hLmtleS5sZW5ndGgpO1xuICBjb25zdCBjbHVzdGVyaW5nT3JkZXIgPSBbXTtcblxuICBmb3IgKGxldCBmaWVsZCA9IDA7IGZpZWxkIDwgY2x1c3RlcmluZ0tleS5sZW5ndGg7IGZpZWxkKyspIHtcbiAgICBpZiAodmlld1NjaGVtYS5jbHVzdGVyaW5nX29yZGVyXG4gICAgICAgICYmIHZpZXdTY2hlbWEuY2x1c3RlcmluZ19vcmRlcltjbHVzdGVyaW5nS2V5W2ZpZWxkXV1cbiAgICAgICAgJiYgdmlld1NjaGVtYS5jbHVzdGVyaW5nX29yZGVyW2NsdXN0ZXJpbmdLZXlbZmllbGRdXS50b0xvd2VyQ2FzZSgpID09PSAnZGVzYycpIHtcbiAgICAgIGNsdXN0ZXJpbmdPcmRlci5wdXNoKHV0aWwuZm9ybWF0KCdcIiVzXCIgREVTQycsIGNsdXN0ZXJpbmdLZXlbZmllbGRdKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNsdXN0ZXJpbmdPcmRlci5wdXNoKHV0aWwuZm9ybWF0KCdcIiVzXCIgQVNDJywgY2x1c3RlcmluZ0tleVtmaWVsZF0pKTtcbiAgICB9XG4gIH1cblxuICBsZXQgY2x1c3RlcmluZ09yZGVyUXVlcnkgPSAnJztcbiAgaWYgKGNsdXN0ZXJpbmdPcmRlci5sZW5ndGggPiAwKSB7XG4gICAgY2x1c3RlcmluZ09yZGVyUXVlcnkgPSB1dGlsLmZvcm1hdCgnIFdJVEggQ0xVU1RFUklORyBPUkRFUiBCWSAoJXMpJywgY2x1c3RlcmluZ09yZGVyLnRvU3RyaW5nKCkpO1xuICB9XG5cbiAgaWYgKHBhcnRpdGlvbktleSBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgcGFydGl0aW9uS2V5ID0gcGFydGl0aW9uS2V5Lm1hcCgodikgPT4gdXRpbC5mb3JtYXQoJ1wiJXNcIicsIHYpKS5qb2luKCcsJyk7XG4gIH0gZWxzZSB7XG4gICAgcGFydGl0aW9uS2V5ID0gdXRpbC5mb3JtYXQoJ1wiJXNcIicsIHBhcnRpdGlvbktleSk7XG4gIH1cblxuICBpZiAoY2x1c3RlcmluZ0tleS5sZW5ndGgpIHtcbiAgICBjbHVzdGVyaW5nS2V5ID0gY2x1c3RlcmluZ0tleS5tYXAoKHYpID0+ICh1dGlsLmZvcm1hdCgnXCIlc1wiJywgdikpKS5qb2luKCcsJyk7XG4gICAgY2x1c3RlcmluZ0tleSA9IHV0aWwuZm9ybWF0KCcsJXMnLCBjbHVzdGVyaW5nS2V5KTtcbiAgfSBlbHNlIHtcbiAgICBjbHVzdGVyaW5nS2V5ID0gJyc7XG4gIH1cblxuICBsZXQgd2hlcmVDbGF1c2UgPSBwYXJ0aXRpb25LZXkuc3BsaXQoJywnKS5qb2luKCcgSVMgTk9UIE5VTEwgQU5EICcpO1xuICBpZiAoY2x1c3RlcmluZ0tleSkgd2hlcmVDbGF1c2UgKz0gY2x1c3RlcmluZ0tleS5zcGxpdCgnLCcpLmpvaW4oJyBJUyBOT1QgTlVMTCBBTkQgJyk7XG4gIHdoZXJlQ2xhdXNlICs9ICcgSVMgTk9UIE5VTEwnO1xuXG4gIGNvbnN0IHF1ZXJ5ID0gdXRpbC5mb3JtYXQoXG4gICAgJ0NSRUFURSBNQVRFUklBTElaRUQgVklFVyBJRiBOT1QgRVhJU1RTIFwiJXNcIiBBUyBTRUxFQ1QgJXMgRlJPTSBcIiVzXCIgV0hFUkUgJXMgUFJJTUFSWSBLRVkoKCVzKSVzKSVzOycsXG4gICAgdmlld05hbWUsXG4gICAgcm93cy5qb2luKCcgLCAnKSxcbiAgICB0YWJsZU5hbWUsXG4gICAgd2hlcmVDbGF1c2UsXG4gICAgcGFydGl0aW9uS2V5LFxuICAgIGNsdXN0ZXJpbmdLZXksXG4gICAgY2x1c3RlcmluZ09yZGVyUXVlcnksXG4gICk7XG5cbiAgcmV0dXJuIHF1ZXJ5O1xufTtcblxuQmFzZU1vZGVsLl9jcmVhdGVfaW5kZXhfcXVlcnkgPSBmdW5jdGlvbiBmKHRhYmxlTmFtZSwgaW5kZXhOYW1lKSB7XG4gIGxldCBxdWVyeTtcbiAgY29uc3QgaW5kZXhFeHByZXNzaW9uID0gaW5kZXhOYW1lLnJlcGxhY2UoL1tcIlxcc10vZywgJycpLnNwbGl0KC9bKCldL2cpO1xuICBpZiAoaW5kZXhFeHByZXNzaW9uLmxlbmd0aCA+IDEpIHtcbiAgICBpbmRleEV4cHJlc3Npb25bMF0gPSBpbmRleEV4cHJlc3Npb25bMF0udG9Mb3dlckNhc2UoKTtcbiAgICBxdWVyeSA9IHV0aWwuZm9ybWF0KFxuICAgICAgJ0NSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTIE9OIFwiJXNcIiAoJXMoXCIlc1wiKSk7JyxcbiAgICAgIHRhYmxlTmFtZSxcbiAgICAgIGluZGV4RXhwcmVzc2lvblswXSxcbiAgICAgIGluZGV4RXhwcmVzc2lvblsxXSxcbiAgICApO1xuICB9IGVsc2Uge1xuICAgIHF1ZXJ5ID0gdXRpbC5mb3JtYXQoXG4gICAgICAnQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgT04gXCIlc1wiIChcIiVzXCIpOycsXG4gICAgICB0YWJsZU5hbWUsXG4gICAgICBpbmRleEV4cHJlc3Npb25bMF0sXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiBxdWVyeTtcbn07XG5cbkJhc2VNb2RlbC5fY3JlYXRlX2N1c3RvbV9pbmRleF9xdWVyeSA9IGZ1bmN0aW9uIGYodGFibGVOYW1lLCBjdXN0b21JbmRleCkge1xuICBsZXQgcXVlcnkgPSB1dGlsLmZvcm1hdChcbiAgICAnQ1JFQVRFIENVU1RPTSBJTkRFWCBJRiBOT1QgRVhJU1RTIE9OIFwiJXNcIiAoXCIlc1wiKSBVU0lORyBcXCclc1xcJycsXG4gICAgdGFibGVOYW1lLFxuICAgIGN1c3RvbUluZGV4Lm9uLFxuICAgIGN1c3RvbUluZGV4LnVzaW5nLFxuICApO1xuXG4gIGlmIChPYmplY3Qua2V5cyhjdXN0b21JbmRleC5vcHRpb25zKS5sZW5ndGggPiAwKSB7XG4gICAgcXVlcnkgKz0gJyBXSVRIIE9QVElPTlMgPSB7JztcbiAgICBPYmplY3Qua2V5cyhjdXN0b21JbmRleC5vcHRpb25zKS5mb3JFYWNoKChrZXkpID0+IHtcbiAgICAgIHF1ZXJ5ICs9IHV0aWwuZm9ybWF0KFwiJyVzJzogJyVzJywgXCIsIGtleSwgY3VzdG9tSW5kZXgub3B0aW9uc1trZXldKTtcbiAgICB9KTtcbiAgICBxdWVyeSA9IHF1ZXJ5LnNsaWNlKDAsIC0yKTtcbiAgICBxdWVyeSArPSAnfSc7XG4gIH1cblxuICBxdWVyeSArPSAnOyc7XG5cbiAgcmV0dXJuIHF1ZXJ5O1xufTtcblxuQmFzZU1vZGVsLl9nZXRfZGJfdGFibGVfc2NoZW1hID0gZnVuY3Rpb24gZihjYWxsYmFjaykge1xuICBjb25zdCBzZWxmID0gdGhpcztcblxuICBjb25zdCB0YWJsZU5hbWUgPSB0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWU7XG4gIGNvbnN0IGtleXNwYWNlID0gdGhpcy5fcHJvcGVydGllcy5rZXlzcGFjZTtcblxuICBsZXQgcXVlcnkgPSAnU0VMRUNUICogRlJPTSBzeXN0ZW1fc2NoZW1hLmNvbHVtbnMgV0hFUkUgdGFibGVfbmFtZSA9ID8gQU5EIGtleXNwYWNlX25hbWUgPSA/Oyc7XG5cbiAgc2VsZi5leGVjdXRlX3F1ZXJ5KHF1ZXJ5LCBbdGFibGVOYW1lLCBrZXlzcGFjZV0sIChlcnIsIHJlc3VsdENvbHVtbnMpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRic2NoZW1hcXVlcnknLCBlcnIpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoIXJlc3VsdENvbHVtbnMucm93cyB8fCByZXN1bHRDb2x1bW5zLnJvd3MubGVuZ3RoID09PSAwKSB7XG4gICAgICBjYWxsYmFjayhudWxsLCBudWxsKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBkYlNjaGVtYSA9IHsgZmllbGRzOiB7fSwgdHlwZU1hcHM6IHt9LCBzdGF0aWNNYXBzOiB7fSB9O1xuXG4gICAgZm9yIChsZXQgciA9IDA7IHIgPCByZXN1bHRDb2x1bW5zLnJvd3MubGVuZ3RoOyByKyspIHtcbiAgICAgIGNvbnN0IHJvdyA9IHJlc3VsdENvbHVtbnMucm93c1tyXTtcblxuICAgICAgZGJTY2hlbWEuZmllbGRzW3Jvdy5jb2x1bW5fbmFtZV0gPSBUWVBFX01BUC5leHRyYWN0X3R5cGUocm93LnR5cGUpO1xuXG4gICAgICBjb25zdCB0eXBlTWFwRGVmID0gVFlQRV9NQVAuZXh0cmFjdF90eXBlRGVmKHJvdy50eXBlKTtcbiAgICAgIGlmICh0eXBlTWFwRGVmLmxlbmd0aCA+IDApIHtcbiAgICAgICAgZGJTY2hlbWEudHlwZU1hcHNbcm93LmNvbHVtbl9uYW1lXSA9IHR5cGVNYXBEZWY7XG4gICAgICB9XG5cbiAgICAgIGlmIChyb3cua2luZCA9PT0gJ3BhcnRpdGlvbl9rZXknKSB7XG4gICAgICAgIGlmICghZGJTY2hlbWEua2V5KSBkYlNjaGVtYS5rZXkgPSBbW11dO1xuICAgICAgICBkYlNjaGVtYS5rZXlbMF1bcm93LnBvc2l0aW9uXSA9IHJvdy5jb2x1bW5fbmFtZTtcbiAgICAgIH0gZWxzZSBpZiAocm93LmtpbmQgPT09ICdjbHVzdGVyaW5nJykge1xuICAgICAgICBpZiAoIWRiU2NoZW1hLmtleSkgZGJTY2hlbWEua2V5ID0gW1tdXTtcbiAgICAgICAgaWYgKCFkYlNjaGVtYS5jbHVzdGVyaW5nX29yZGVyKSBkYlNjaGVtYS5jbHVzdGVyaW5nX29yZGVyID0ge307XG5cbiAgICAgICAgZGJTY2hlbWEua2V5W3Jvdy5wb3NpdGlvbiArIDFdID0gcm93LmNvbHVtbl9uYW1lO1xuICAgICAgICBpZiAocm93LmNsdXN0ZXJpbmdfb3JkZXIgJiYgcm93LmNsdXN0ZXJpbmdfb3JkZXIudG9Mb3dlckNhc2UoKSA9PT0gJ2Rlc2MnKSB7XG4gICAgICAgICAgZGJTY2hlbWEuY2x1c3RlcmluZ19vcmRlcltyb3cuY29sdW1uX25hbWVdID0gJ0RFU0MnO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGRiU2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJbcm93LmNvbHVtbl9uYW1lXSA9ICdBU0MnO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKHJvdy5raW5kID09PSAnc3RhdGljJykge1xuICAgICAgICBkYlNjaGVtYS5zdGF0aWNNYXBzW3Jvdy5jb2x1bW5fbmFtZV0gPSB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIHF1ZXJ5ID0gJ1NFTEVDVCAqIEZST00gc3lzdGVtX3NjaGVtYS5pbmRleGVzIFdIRVJFIHRhYmxlX25hbWUgPSA/IEFORCBrZXlzcGFjZV9uYW1lID0gPzsnO1xuXG4gICAgc2VsZi5leGVjdXRlX3F1ZXJ5KHF1ZXJ5LCBbdGFibGVOYW1lLCBrZXlzcGFjZV0sIChlcnIxLCByZXN1bHRJbmRleGVzKSA9PiB7XG4gICAgICBpZiAoZXJyMSkge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRic2NoZW1hcXVlcnknLCBlcnIxKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgZm9yIChsZXQgciA9IDA7IHIgPCByZXN1bHRJbmRleGVzLnJvd3MubGVuZ3RoOyByKyspIHtcbiAgICAgICAgY29uc3Qgcm93ID0gcmVzdWx0SW5kZXhlcy5yb3dzW3JdO1xuXG4gICAgICAgIGlmIChyb3cuaW5kZXhfbmFtZSkge1xuICAgICAgICAgIGNvbnN0IGluZGV4T3B0aW9ucyA9IHJvdy5vcHRpb25zO1xuICAgICAgICAgIGxldCB0YXJnZXQgPSBpbmRleE9wdGlvbnMudGFyZ2V0O1xuICAgICAgICAgIHRhcmdldCA9IHRhcmdldC5yZXBsYWNlKC9bXCJcXHNdL2csICcnKTtcbiAgICAgICAgICBkZWxldGUgaW5kZXhPcHRpb25zLnRhcmdldDtcblxuICAgICAgICAgIC8vIGtlZXBpbmcgdHJhY2sgb2YgaW5kZXggbmFtZXMgdG8gZHJvcCBpbmRleCB3aGVuIG5lZWRlZFxuICAgICAgICAgIGlmICghZGJTY2hlbWEuaW5kZXhfbmFtZXMpIGRiU2NoZW1hLmluZGV4X25hbWVzID0ge307XG5cbiAgICAgICAgICBpZiAocm93LmtpbmQgPT09ICdDVVNUT00nKSB7XG4gICAgICAgICAgICBjb25zdCB1c2luZyA9IGluZGV4T3B0aW9ucy5jbGFzc19uYW1lO1xuICAgICAgICAgICAgZGVsZXRlIGluZGV4T3B0aW9ucy5jbGFzc19uYW1lO1xuXG4gICAgICAgICAgICBpZiAoIWRiU2NoZW1hLmN1c3RvbV9pbmRleGVzKSBkYlNjaGVtYS5jdXN0b21faW5kZXhlcyA9IFtdO1xuICAgICAgICAgICAgY29uc3QgY3VzdG9tSW5kZXhPYmplY3QgPSB7XG4gICAgICAgICAgICAgIG9uOiB0YXJnZXQsXG4gICAgICAgICAgICAgIHVzaW5nLFxuICAgICAgICAgICAgICBvcHRpb25zOiBpbmRleE9wdGlvbnMsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgZGJTY2hlbWEuY3VzdG9tX2luZGV4ZXMucHVzaChjdXN0b21JbmRleE9iamVjdCk7XG4gICAgICAgICAgICBkYlNjaGVtYS5pbmRleF9uYW1lc1tvYmplY3RIYXNoKGN1c3RvbUluZGV4T2JqZWN0KV0gPSByb3cuaW5kZXhfbmFtZTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKCFkYlNjaGVtYS5pbmRleGVzKSBkYlNjaGVtYS5pbmRleGVzID0gW107XG4gICAgICAgICAgICBkYlNjaGVtYS5pbmRleGVzLnB1c2godGFyZ2V0KTtcbiAgICAgICAgICAgIGRiU2NoZW1hLmluZGV4X25hbWVzW3RhcmdldF0gPSByb3cuaW5kZXhfbmFtZTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgcXVlcnkgPSAnU0VMRUNUIHZpZXdfbmFtZSxiYXNlX3RhYmxlX25hbWUgRlJPTSBzeXN0ZW1fc2NoZW1hLnZpZXdzIFdIRVJFIGtleXNwYWNlX25hbWU9PzsnO1xuXG4gICAgICBzZWxmLmV4ZWN1dGVfcXVlcnkocXVlcnksIFtrZXlzcGFjZV0sIChlcnIyLCByZXN1bHRWaWV3cykgPT4ge1xuICAgICAgICBpZiAoZXJyMikge1xuICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJzY2hlbWFxdWVyeScsIGVycjIpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBmb3IgKGxldCByID0gMDsgciA8IHJlc3VsdFZpZXdzLnJvd3MubGVuZ3RoOyByKyspIHtcbiAgICAgICAgICBjb25zdCByb3cgPSByZXN1bHRWaWV3cy5yb3dzW3JdO1xuXG4gICAgICAgICAgaWYgKHJvdy5iYXNlX3RhYmxlX25hbWUgPT09IHRhYmxlTmFtZSkge1xuICAgICAgICAgICAgaWYgKCFkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3MpIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cyA9IHt9O1xuICAgICAgICAgICAgZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy52aWV3X25hbWVdID0ge307XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cykge1xuICAgICAgICAgIHF1ZXJ5ID0gJ1NFTEVDVCAqIEZST00gc3lzdGVtX3NjaGVtYS5jb2x1bW5zIFdIRVJFIGtleXNwYWNlX25hbWU9PyBhbmQgdGFibGVfbmFtZSBJTiA/Oyc7XG5cbiAgICAgICAgICBzZWxmLmV4ZWN1dGVfcXVlcnkocXVlcnksIFtrZXlzcGFjZSwgT2JqZWN0LmtleXMoZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzKV0sIChlcnIzLCByZXN1bHRNYXRWaWV3cykgPT4ge1xuICAgICAgICAgICAgaWYgKGVycjMpIHtcbiAgICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5kYnNjaGVtYXF1ZXJ5JywgZXJyMykpO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZvciAobGV0IHIgPSAwOyByIDwgcmVzdWx0TWF0Vmlld3Mucm93cy5sZW5ndGg7IHIrKykge1xuICAgICAgICAgICAgICBjb25zdCByb3cgPSByZXN1bHRNYXRWaWV3cy5yb3dzW3JdO1xuXG4gICAgICAgICAgICAgIGlmICghZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5zZWxlY3QpIHtcbiAgICAgICAgICAgICAgICBkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLnNlbGVjdCA9IFtdO1xuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5zZWxlY3QucHVzaChyb3cuY29sdW1uX25hbWUpO1xuXG4gICAgICAgICAgICAgIGlmIChyb3cua2luZCA9PT0gJ3BhcnRpdGlvbl9rZXknKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLmtleSkge1xuICAgICAgICAgICAgICAgICAgZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5rZXkgPSBbW11dO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0ua2V5WzBdW3Jvdy5wb3NpdGlvbl0gPSByb3cuY29sdW1uX25hbWU7XG4gICAgICAgICAgICAgIH0gZWxzZSBpZiAocm93LmtpbmQgPT09ICdjbHVzdGVyaW5nJykge1xuICAgICAgICAgICAgICAgIGlmICghZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5rZXkpIHtcbiAgICAgICAgICAgICAgICAgIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0ua2V5ID0gW1tdXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKCFkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLmNsdXN0ZXJpbmdfb3JkZXIpIHtcbiAgICAgICAgICAgICAgICAgIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0uY2x1c3RlcmluZ19vcmRlciA9IHt9O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0ua2V5W3Jvdy5wb3NpdGlvbiArIDFdID0gcm93LmNvbHVtbl9uYW1lO1xuICAgICAgICAgICAgICAgIGlmIChyb3cuY2x1c3RlcmluZ19vcmRlciAmJiByb3cuY2x1c3RlcmluZ19vcmRlci50b0xvd2VyQ2FzZSgpID09PSAnZGVzYycpIHtcbiAgICAgICAgICAgICAgICAgIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0uY2x1c3RlcmluZ19vcmRlcltyb3cuY29sdW1uX25hbWVdID0gJ0RFU0MnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICBkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLmNsdXN0ZXJpbmdfb3JkZXJbcm93LmNvbHVtbl9uYW1lXSA9ICdBU0MnO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjYWxsYmFjayhudWxsLCBkYlNjaGVtYSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY2FsbGJhY2sobnVsbCwgZGJTY2hlbWEpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuX2V4ZWN1dGVfdGFibGVfcXVlcnkgPSBmdW5jdGlvbiBmKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAzKSB7XG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgIG9wdGlvbnMgPSB7fTtcbiAgfVxuXG4gIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgIHByZXBhcmU6IHRydWUsXG4gIH07XG5cbiAgb3B0aW9ucyA9IF8uZGVmYXVsdHNEZWVwKG9wdGlvbnMsIGRlZmF1bHRzKTtcblxuICBjb25zdCBkb0V4ZWN1dGVRdWVyeSA9IGZ1bmN0aW9uIGYxKGRvcXVlcnksIGRvY2FsbGJhY2spIHtcbiAgICB0aGlzLmV4ZWN1dGVfcXVlcnkoZG9xdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBkb2NhbGxiYWNrKTtcbiAgfS5iaW5kKHRoaXMsIHF1ZXJ5KTtcblxuICBpZiAodGhpcy5pc190YWJsZV9yZWFkeSgpKSB7XG4gICAgZG9FeGVjdXRlUXVlcnkoY2FsbGJhY2spO1xuICB9IGVsc2Uge1xuICAgIHRoaXMuaW5pdCgoZXJyKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGRvRXhlY3V0ZVF1ZXJ5KGNhbGxiYWNrKTtcbiAgICB9KTtcbiAgfVxufTtcblxuQmFzZU1vZGVsLl9nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbiA9IGZ1bmN0aW9uIGYoZmllbGRuYW1lLCBmaWVsZHZhbHVlKSB7XG4gIGlmIChmaWVsZHZhbHVlID09IG51bGwgfHwgZmllbGR2YWx1ZSA9PT0gY3FsLnR5cGVzLnVuc2V0KSB7XG4gICAgcmV0dXJuIHsgcXVlcnlfc2VnbWVudDogJz8nLCBwYXJhbWV0ZXI6IGZpZWxkdmFsdWUgfTtcbiAgfVxuXG4gIGlmIChfLmlzUGxhaW5PYmplY3QoZmllbGR2YWx1ZSkgJiYgZmllbGR2YWx1ZS4kZGJfZnVuY3Rpb24pIHtcbiAgICByZXR1cm4gZmllbGR2YWx1ZS4kZGJfZnVuY3Rpb247XG4gIH1cblxuICBjb25zdCBmaWVsZHR5cGUgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHRoaXMuX3Byb3BlcnRpZXMuc2NoZW1hLCBmaWVsZG5hbWUpO1xuICBjb25zdCB2YWxpZGF0b3JzID0gdGhpcy5fZ2V0X3ZhbGlkYXRvcnMoZmllbGRuYW1lKTtcblxuICBpZiAoZmllbGR2YWx1ZSBpbnN0YW5jZW9mIEFycmF5ICYmIGZpZWxkdHlwZSAhPT0gJ2xpc3QnICYmIGZpZWxkdHlwZSAhPT0gJ3NldCcgJiYgZmllbGR0eXBlICE9PSAnZnJvemVuJykge1xuICAgIGNvbnN0IHZhbCA9IGZpZWxkdmFsdWUubWFwKCh2KSA9PiB7XG4gICAgICBjb25zdCBkYlZhbCA9IHRoaXMuX2dldF9kYl92YWx1ZV9leHByZXNzaW9uKGZpZWxkbmFtZSwgdik7XG5cbiAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHJldHVybiBkYlZhbC5wYXJhbWV0ZXI7XG4gICAgICByZXR1cm4gZGJWYWw7XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBxdWVyeV9zZWdtZW50OiAnPycsIHBhcmFtZXRlcjogdmFsIH07XG4gIH1cblxuICBjb25zdCB2YWxpZGF0aW9uTWVzc2FnZSA9IHRoaXMuX3ZhbGlkYXRlKHZhbGlkYXRvcnMsIGZpZWxkdmFsdWUpO1xuICBpZiAodmFsaWRhdGlvbk1lc3NhZ2UgIT09IHRydWUpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWR2YWx1ZScsIHZhbGlkYXRpb25NZXNzYWdlKGZpZWxkdmFsdWUsIGZpZWxkbmFtZSwgZmllbGR0eXBlKSkpO1xuICB9XG5cbiAgaWYgKGZpZWxkdHlwZSA9PT0gJ2NvdW50ZXInKSB7XG4gICAgbGV0IGNvdW50ZXJRdWVyeVNlZ21lbnQgPSB1dGlsLmZvcm1hdCgnXCIlc1wiJywgZmllbGRuYW1lKTtcbiAgICBpZiAoZmllbGR2YWx1ZSA+PSAwKSBjb3VudGVyUXVlcnlTZWdtZW50ICs9ICcgKyA/JztcbiAgICBlbHNlIGNvdW50ZXJRdWVyeVNlZ21lbnQgKz0gJyAtID8nO1xuICAgIGZpZWxkdmFsdWUgPSBNYXRoLmFicyhmaWVsZHZhbHVlKTtcbiAgICByZXR1cm4geyBxdWVyeV9zZWdtZW50OiBjb3VudGVyUXVlcnlTZWdtZW50LCBwYXJhbWV0ZXI6IGZpZWxkdmFsdWUgfTtcbiAgfVxuXG4gIHJldHVybiB7IHF1ZXJ5X3NlZ21lbnQ6ICc/JywgcGFyYW1ldGVyOiBmaWVsZHZhbHVlIH07XG59O1xuXG5CYXNlTW9kZWwuX3BhcnNlX3F1ZXJ5X29iamVjdCA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QpIHtcbiAgY29uc3QgcXVlcnlSZWxhdGlvbnMgPSBbXTtcbiAgY29uc3QgcXVlcnlQYXJhbXMgPSBbXTtcblxuICBPYmplY3Qua2V5cyhxdWVyeU9iamVjdCkuZm9yRWFjaCgoaykgPT4ge1xuICAgIGlmIChrLmluZGV4T2YoJyQnKSA9PT0gMCkge1xuICAgICAgLy8gc2VhcmNoIHF1ZXJpZXMgYmFzZWQgb24gbHVjZW5lIGluZGV4IG9yIHNvbHJcbiAgICAgIC8vIGVzY2FwZSBhbGwgc2luZ2xlIHF1b3RlcyBmb3IgcXVlcmllcyBpbiBjYXNzYW5kcmFcbiAgICAgIGlmIChrID09PSAnJGV4cHInKSB7XG4gICAgICAgIGlmICh0eXBlb2YgcXVlcnlPYmplY3Rba10uaW5kZXggPT09ICdzdHJpbmcnICYmIHR5cGVvZiBxdWVyeU9iamVjdFtrXS5xdWVyeSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgXCJleHByKCVzLCclcycpXCIsXG4gICAgICAgICAgICBxdWVyeU9iamVjdFtrXS5pbmRleCwgcXVlcnlPYmplY3Rba10ucXVlcnkucmVwbGFjZSgvJy9nLCBcIicnXCIpLFxuICAgICAgICAgICkpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRleHByJykpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGsgPT09ICckc29scl9xdWVyeScpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBxdWVyeU9iamVjdFtrXSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgXCJzb2xyX3F1ZXJ5PSclcydcIixcbiAgICAgICAgICAgIHF1ZXJ5T2JqZWN0W2tdLnJlcGxhY2UoLycvZywgXCInJ1wiKSxcbiAgICAgICAgICApKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkc29scnF1ZXJ5JykpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgbGV0IHdoZXJlT2JqZWN0ID0gcXVlcnlPYmplY3Rba107XG4gICAgLy8gQXJyYXkgb2Ygb3BlcmF0b3JzXG4gICAgaWYgKCEod2hlcmVPYmplY3QgaW5zdGFuY2VvZiBBcnJheSkpIHdoZXJlT2JqZWN0ID0gW3doZXJlT2JqZWN0XTtcblxuICAgIGZvciAobGV0IGZrID0gMDsgZmsgPCB3aGVyZU9iamVjdC5sZW5ndGg7IGZrKyspIHtcbiAgICAgIGxldCBmaWVsZFJlbGF0aW9uID0gd2hlcmVPYmplY3RbZmtdO1xuXG4gICAgICBjb25zdCBjcWxPcGVyYXRvcnMgPSB7XG4gICAgICAgICRlcTogJz0nLFxuICAgICAgICAkbmU6ICchPScsXG4gICAgICAgICRndDogJz4nLFxuICAgICAgICAkbHQ6ICc8JyxcbiAgICAgICAgJGd0ZTogJz49JyxcbiAgICAgICAgJGx0ZTogJzw9JyxcbiAgICAgICAgJGluOiAnSU4nLFxuICAgICAgICAkbGlrZTogJ0xJS0UnLFxuICAgICAgICAkdG9rZW46ICd0b2tlbicsXG4gICAgICAgICRjb250YWluczogJ0NPTlRBSU5TJyxcbiAgICAgICAgJGNvbnRhaW5zX2tleTogJ0NPTlRBSU5TIEtFWScsXG4gICAgICB9O1xuXG4gICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGZpZWxkUmVsYXRpb24pKSB7XG4gICAgICAgIGNvbnN0IHZhbGlkS2V5cyA9IE9iamVjdC5rZXlzKGNxbE9wZXJhdG9ycyk7XG4gICAgICAgIGNvbnN0IGZpZWxkUmVsYXRpb25LZXlzID0gT2JqZWN0LmtleXMoZmllbGRSZWxhdGlvbik7XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZmllbGRSZWxhdGlvbktleXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICBpZiAodmFsaWRLZXlzLmluZGV4T2YoZmllbGRSZWxhdGlvbktleXNbaV0pIDwgMCkgeyAvLyBmaWVsZCByZWxhdGlvbiBrZXkgaW52YWxpZFxuICAgICAgICAgICAgZmllbGRSZWxhdGlvbiA9IHsgJGVxOiBmaWVsZFJlbGF0aW9uIH07XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGZpZWxkUmVsYXRpb24gPSB7ICRlcTogZmllbGRSZWxhdGlvbiB9O1xuICAgICAgfVxuXG4gICAgICBjb25zdCByZWxLZXlzID0gT2JqZWN0LmtleXMoZmllbGRSZWxhdGlvbik7XG4gICAgICBmb3IgKGxldCByayA9IDA7IHJrIDwgcmVsS2V5cy5sZW5ndGg7IHJrKyspIHtcbiAgICAgICAgbGV0IGZpcnN0S2V5ID0gcmVsS2V5c1tya107XG4gICAgICAgIGNvbnN0IGZpcnN0VmFsdWUgPSBmaWVsZFJlbGF0aW9uW2ZpcnN0S2V5XTtcbiAgICAgICAgaWYgKGZpcnN0S2V5LnRvTG93ZXJDYXNlKCkgaW4gY3FsT3BlcmF0b3JzKSB7XG4gICAgICAgICAgZmlyc3RLZXkgPSBmaXJzdEtleS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICAgIGxldCBvcCA9IGNxbE9wZXJhdG9yc1tmaXJzdEtleV07XG5cbiAgICAgICAgICBpZiAoZmlyc3RLZXkgPT09ICckaW4nICYmICEoZmlyc3RWYWx1ZSBpbnN0YW5jZW9mIEFycmF5KSkgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZGlub3AnKSk7XG4gICAgICAgICAgaWYgKGZpcnN0S2V5ID09PSAnJHRva2VuJyAmJiAhKGZpcnN0VmFsdWUgaW5zdGFuY2VvZiBPYmplY3QpKSB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkdG9rZW4nKSk7XG5cbiAgICAgICAgICBsZXQgd2hlcmVUZW1wbGF0ZSA9ICdcIiVzXCIgJXMgJXMnO1xuICAgICAgICAgIGlmIChmaXJzdEtleSA9PT0gJyR0b2tlbicpIHtcbiAgICAgICAgICAgIHdoZXJlVGVtcGxhdGUgPSAndG9rZW4oXCIlc1wiKSAlcyB0b2tlbiglcyknO1xuXG4gICAgICAgICAgICBjb25zdCB0b2tlblJlbEtleXMgPSBPYmplY3Qua2V5cyhmaXJzdFZhbHVlKTtcbiAgICAgICAgICAgIGZvciAobGV0IHRva2VuUksgPSAwOyB0b2tlblJLIDwgdG9rZW5SZWxLZXlzLmxlbmd0aDsgdG9rZW5SSysrKSB7XG4gICAgICAgICAgICAgIGxldCB0b2tlbkZpcnN0S2V5ID0gdG9rZW5SZWxLZXlzW3Rva2VuUktdO1xuICAgICAgICAgICAgICBjb25zdCB0b2tlbkZpcnN0VmFsdWUgPSBmaXJzdFZhbHVlW3Rva2VuRmlyc3RLZXldO1xuICAgICAgICAgICAgICB0b2tlbkZpcnN0S2V5ID0gdG9rZW5GaXJzdEtleS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICAgICAgICBpZiAoKHRva2VuRmlyc3RLZXkgaW4gY3FsT3BlcmF0b3JzKSAmJiB0b2tlbkZpcnN0S2V5ICE9PSAnJHRva2VuJyAmJiB0b2tlbkZpcnN0S2V5ICE9PSAnJGluJykge1xuICAgICAgICAgICAgICAgIG9wID0gY3FsT3BlcmF0b3JzW3Rva2VuRmlyc3RLZXldO1xuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWR0b2tlbm9wJywgdG9rZW5GaXJzdEtleSkpO1xuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgaWYgKHRva2VuRmlyc3RWYWx1ZSBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgICAgICAgICAgICAgY29uc3QgdG9rZW5LZXlzID0gay5zcGxpdCgnLCcpO1xuICAgICAgICAgICAgICAgIGZvciAobGV0IHRva2VuSW5kZXggPSAwOyB0b2tlbkluZGV4IDwgdG9rZW5GaXJzdFZhbHVlLmxlbmd0aDsgdG9rZW5JbmRleCsrKSB7XG4gICAgICAgICAgICAgICAgICB0b2tlbktleXNbdG9rZW5JbmRleF0gPSB0b2tlbktleXNbdG9rZW5JbmRleF0udHJpbSgpO1xuICAgICAgICAgICAgICAgICAgY29uc3QgZGJWYWwgPSB0aGlzLl9nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbih0b2tlbktleXNbdG9rZW5JbmRleF0sIHRva2VuRmlyc3RWYWx1ZVt0b2tlbkluZGV4XSk7XG4gICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGRiVmFsKSAmJiBkYlZhbC5xdWVyeV9zZWdtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRva2VuRmlyc3RWYWx1ZVt0b2tlbkluZGV4XSA9IGRiVmFsLnF1ZXJ5X3NlZ21lbnQ7XG4gICAgICAgICAgICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyKTtcbiAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRva2VuRmlyc3RWYWx1ZVt0b2tlbkluZGV4XSA9IGRiVmFsO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgd2hlcmVUZW1wbGF0ZSxcbiAgICAgICAgICAgICAgICAgIHRva2VuS2V5cy5qb2luKCdcIixcIicpLCBvcCwgdG9rZW5GaXJzdFZhbHVlLnRvU3RyaW5nKCksXG4gICAgICAgICAgICAgICAgKSk7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29uc3QgZGJWYWwgPSB0aGlzLl9nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihrLCB0b2tlbkZpcnN0VmFsdWUpO1xuICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHtcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICAgICAgICAgICAgICAgIGssIG9wLCBkYlZhbC5xdWVyeV9zZWdtZW50LFxuICAgICAgICAgICAgICAgICAgKSk7XG4gICAgICAgICAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICAgICAgICAgICAgICAgIGssIG9wLCBkYlZhbCxcbiAgICAgICAgICAgICAgICAgICkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSBpZiAoZmlyc3RLZXkgPT09ICckY29udGFpbnMnKSB7XG4gICAgICAgICAgICBjb25zdCBmaWVsZHR5cGUxID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZSh0aGlzLl9wcm9wZXJ0aWVzLnNjaGVtYSwgayk7XG4gICAgICAgICAgICBpZiAoWydtYXAnLCAnbGlzdCcsICdzZXQnLCAnZnJvemVuJ10uaW5kZXhPZihmaWVsZHR5cGUxKSA+PSAwKSB7XG4gICAgICAgICAgICAgIGlmIChmaWVsZHR5cGUxID09PSAnbWFwJyAmJiBfLmlzUGxhaW5PYmplY3QoZmlyc3RWYWx1ZSkgJiYgT2JqZWN0LmtleXMoZmlyc3RWYWx1ZSkubGVuZ3RoID09PSAxKSB7XG4gICAgICAgICAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAgICdcIiVzXCJbJXNdICVzICVzJyxcbiAgICAgICAgICAgICAgICAgIGssICc/JywgJz0nLCAnPycsXG4gICAgICAgICAgICAgICAgKSk7XG4gICAgICAgICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChPYmplY3Qua2V5cyhmaXJzdFZhbHVlKVswXSk7XG4gICAgICAgICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChmaXJzdFZhbHVlW09iamVjdC5rZXlzKGZpcnN0VmFsdWUpWzBdXSk7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICAgICAgICAgICAgICBrLCBvcCwgJz8nLFxuICAgICAgICAgICAgICAgICkpO1xuICAgICAgICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZmlyc3RWYWx1ZSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRjb250YWluc29wJykpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSBpZiAoZmlyc3RLZXkgPT09ICckY29udGFpbnNfa2V5Jykge1xuICAgICAgICAgICAgY29uc3QgZmllbGR0eXBlMiA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUodGhpcy5fcHJvcGVydGllcy5zY2hlbWEsIGspO1xuICAgICAgICAgICAgaWYgKFsnbWFwJ10uaW5kZXhPZihmaWVsZHR5cGUyKSA+PSAwKSB7XG4gICAgICAgICAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICAgd2hlcmVUZW1wbGF0ZSxcbiAgICAgICAgICAgICAgICBrLCBvcCwgJz8nLFxuICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChmaXJzdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRjb250YWluc2tleW9wJykpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb25zdCBkYlZhbCA9IHRoaXMuX2dldF9kYl92YWx1ZV9leHByZXNzaW9uKGssIGZpcnN0VmFsdWUpO1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkYlZhbCkgJiYgZGJWYWwucXVlcnlfc2VnbWVudCkge1xuICAgICAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICAgICAgICAgICAgaywgb3AsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQsXG4gICAgICAgICAgICAgICkpO1xuICAgICAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICAgICAgICAgICAgaywgb3AsIGRiVmFsLFxuICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZG9wJywgZmlyc3RLZXkpKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHtcbiAgICBxdWVyeVJlbGF0aW9ucyxcbiAgICBxdWVyeVBhcmFtcyxcbiAgfTtcbn07XG5cbkJhc2VNb2RlbC5fY3JlYXRlX3doZXJlX2NsYXVzZSA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QpIHtcbiAgY29uc3QgcGFyc2VkT2JqZWN0ID0gdGhpcy5fcGFyc2VfcXVlcnlfb2JqZWN0KHF1ZXJ5T2JqZWN0KTtcbiAgY29uc3Qgd2hlcmVDbGF1c2UgPSB7fTtcbiAgaWYgKHBhcnNlZE9iamVjdC5xdWVyeVJlbGF0aW9ucy5sZW5ndGggPiAwKSB7XG4gICAgd2hlcmVDbGF1c2UucXVlcnkgPSB1dGlsLmZvcm1hdCgnV0hFUkUgJXMnLCBwYXJzZWRPYmplY3QucXVlcnlSZWxhdGlvbnMuam9pbignIEFORCAnKSk7XG4gIH0gZWxzZSB7XG4gICAgd2hlcmVDbGF1c2UucXVlcnkgPSAnJztcbiAgfVxuICB3aGVyZUNsYXVzZS5wYXJhbXMgPSBwYXJzZWRPYmplY3QucXVlcnlQYXJhbXM7XG4gIHJldHVybiB3aGVyZUNsYXVzZTtcbn07XG5cbkJhc2VNb2RlbC5fY3JlYXRlX2lmX2NsYXVzZSA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QpIHtcbiAgY29uc3QgcGFyc2VkT2JqZWN0ID0gdGhpcy5fcGFyc2VfcXVlcnlfb2JqZWN0KHF1ZXJ5T2JqZWN0KTtcbiAgY29uc3QgaWZDbGF1c2UgPSB7fTtcbiAgaWYgKHBhcnNlZE9iamVjdC5xdWVyeVJlbGF0aW9ucy5sZW5ndGggPiAwKSB7XG4gICAgaWZDbGF1c2UucXVlcnkgPSB1dGlsLmZvcm1hdCgnSUYgJXMnLCBwYXJzZWRPYmplY3QucXVlcnlSZWxhdGlvbnMuam9pbignIEFORCAnKSk7XG4gIH0gZWxzZSB7XG4gICAgaWZDbGF1c2UucXVlcnkgPSAnJztcbiAgfVxuICBpZkNsYXVzZS5wYXJhbXMgPSBwYXJzZWRPYmplY3QucXVlcnlQYXJhbXM7XG4gIHJldHVybiBpZkNsYXVzZTtcbn07XG5cbkJhc2VNb2RlbC5fY3JlYXRlX2ZpbmRfcXVlcnkgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0LCBvcHRpb25zKSB7XG4gIGNvbnN0IG9yZGVyS2V5cyA9IFtdO1xuICBsZXQgbGltaXQgPSBudWxsO1xuXG4gIE9iamVjdC5rZXlzKHF1ZXJ5T2JqZWN0KS5mb3JFYWNoKChrKSA9PiB7XG4gICAgY29uc3QgcXVlcnlJdGVtID0gcXVlcnlPYmplY3Rba107XG4gICAgaWYgKGsudG9Mb3dlckNhc2UoKSA9PT0gJyRvcmRlcmJ5Jykge1xuICAgICAgaWYgKCEocXVlcnlJdGVtIGluc3RhbmNlb2YgT2JqZWN0KSkge1xuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkb3JkZXInKSk7XG4gICAgICB9XG4gICAgICBjb25zdCBvcmRlckl0ZW1LZXlzID0gT2JqZWN0LmtleXMocXVlcnlJdGVtKTtcblxuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvcmRlckl0ZW1LZXlzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IGNxbE9yZGVyRGlyZWN0aW9uID0geyAkYXNjOiAnQVNDJywgJGRlc2M6ICdERVNDJyB9O1xuICAgICAgICBpZiAob3JkZXJJdGVtS2V5c1tpXS50b0xvd2VyQ2FzZSgpIGluIGNxbE9yZGVyRGlyZWN0aW9uKSB7XG4gICAgICAgICAgbGV0IG9yZGVyRmllbGRzID0gcXVlcnlJdGVtW29yZGVySXRlbUtleXNbaV1dO1xuXG4gICAgICAgICAgaWYgKCEob3JkZXJGaWVsZHMgaW5zdGFuY2VvZiBBcnJheSkpIG9yZGVyRmllbGRzID0gW29yZGVyRmllbGRzXTtcblxuICAgICAgICAgIGZvciAobGV0IGogPSAwOyBqIDwgb3JkZXJGaWVsZHMubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgICAgIG9yZGVyS2V5cy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAnXCIlc1wiICVzJyxcbiAgICAgICAgICAgICAgb3JkZXJGaWVsZHNbal0sIGNxbE9yZGVyRGlyZWN0aW9uW29yZGVySXRlbUtleXNbaV1dLFxuICAgICAgICAgICAgKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRvcmRlcnR5cGUnLCBvcmRlckl0ZW1LZXlzW2ldKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKGsudG9Mb3dlckNhc2UoKSA9PT0gJyRsaW1pdCcpIHtcbiAgICAgIGlmICh0eXBlb2YgcXVlcnlJdGVtICE9PSAnbnVtYmVyJykgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQubGltaXR0eXBlJykpO1xuICAgICAgbGltaXQgPSBxdWVyeUl0ZW07XG4gICAgfVxuICB9KTtcblxuICBjb25zdCB3aGVyZUNsYXVzZSA9IHRoaXMuX2NyZWF0ZV93aGVyZV9jbGF1c2UocXVlcnlPYmplY3QpO1xuXG4gIGxldCBzZWxlY3QgPSAnKic7XG4gIGlmIChvcHRpb25zLnNlbGVjdCAmJiBfLmlzQXJyYXkob3B0aW9ucy5zZWxlY3QpICYmIG9wdGlvbnMuc2VsZWN0Lmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBzZWxlY3RBcnJheSA9IFtdO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgb3B0aW9ucy5zZWxlY3QubGVuZ3RoOyBpKyspIHtcbiAgICAgIC8vIHNlcGFyYXRlIHRoZSBhZ2dyZWdhdGUgZnVuY3Rpb24gYW5kIHRoZSBjb2x1bW4gbmFtZSBpZiBzZWxlY3QgaXMgYW4gYWdncmVnYXRlIGZ1bmN0aW9uXG4gICAgICBjb25zdCBzZWxlY3Rpb24gPSBvcHRpb25zLnNlbGVjdFtpXS5zcGxpdCgvWyggKV0vZykuZmlsdGVyKChlKSA9PiAoZSkpO1xuICAgICAgaWYgKHNlbGVjdGlvbi5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgc2VsZWN0QXJyYXkucHVzaCh1dGlsLmZvcm1hdCgnXCIlc1wiJywgc2VsZWN0aW9uWzBdKSk7XG4gICAgICB9IGVsc2UgaWYgKHNlbGVjdGlvbi5sZW5ndGggPT09IDIgfHwgc2VsZWN0aW9uLmxlbmd0aCA9PT0gNCkge1xuICAgICAgICBsZXQgZnVuY3Rpb25DbGF1c2UgPSB1dGlsLmZvcm1hdCgnJXMoXCIlc1wiKScsIHNlbGVjdGlvblswXSwgc2VsZWN0aW9uWzFdKTtcbiAgICAgICAgaWYgKHNlbGVjdGlvblsyXSkgZnVuY3Rpb25DbGF1c2UgKz0gdXRpbC5mb3JtYXQoJyAlcycsIHNlbGVjdGlvblsyXSk7XG4gICAgICAgIGlmIChzZWxlY3Rpb25bM10pIGZ1bmN0aW9uQ2xhdXNlICs9IHV0aWwuZm9ybWF0KCcgJXMnLCBzZWxlY3Rpb25bM10pO1xuXG4gICAgICAgIHNlbGVjdEFycmF5LnB1c2goZnVuY3Rpb25DbGF1c2UpO1xuICAgICAgfSBlbHNlIGlmIChzZWxlY3Rpb24ubGVuZ3RoID09PSAzKSB7XG4gICAgICAgIHNlbGVjdEFycmF5LnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIiAlcyAlcycsIHNlbGVjdGlvblswXSwgc2VsZWN0aW9uWzFdLCBzZWxlY3Rpb25bMl0pKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHNlbGVjdEFycmF5LnB1c2goJyonKTtcbiAgICAgIH1cbiAgICB9XG4gICAgc2VsZWN0ID0gc2VsZWN0QXJyYXkuam9pbignLCcpO1xuICB9XG5cbiAgbGV0IHF1ZXJ5ID0gdXRpbC5mb3JtYXQoXG4gICAgJ1NFTEVDVCAlcyAlcyBGUk9NIFwiJXNcIiAlcyAlcyAlcycsXG4gICAgKG9wdGlvbnMuZGlzdGluY3QgPyAnRElTVElOQ1QnIDogJycpLFxuICAgIHNlbGVjdCxcbiAgICBvcHRpb25zLm1hdGVyaWFsaXplZF92aWV3ID8gb3B0aW9ucy5tYXRlcmlhbGl6ZWRfdmlldyA6IHRoaXMuX3Byb3BlcnRpZXMudGFibGVfbmFtZSxcbiAgICB3aGVyZUNsYXVzZS5xdWVyeSxcbiAgICBvcmRlcktleXMubGVuZ3RoID8gdXRpbC5mb3JtYXQoJ09SREVSIEJZICVzJywgb3JkZXJLZXlzLmpvaW4oJywgJykpIDogJyAnLFxuICAgIGxpbWl0ID8gdXRpbC5mb3JtYXQoJ0xJTUlUICVzJywgbGltaXQpIDogJyAnLFxuICApO1xuXG4gIGlmIChvcHRpb25zLmFsbG93X2ZpbHRlcmluZykgcXVlcnkgKz0gJyBBTExPVyBGSUxURVJJTkc7JztcbiAgZWxzZSBxdWVyeSArPSAnOyc7XG5cbiAgcmV0dXJuIHsgcXVlcnksIHBhcmFtczogd2hlcmVDbGF1c2UucGFyYW1zIH07XG59O1xuXG5CYXNlTW9kZWwuZ2V0X3RhYmxlX25hbWUgPSBmdW5jdGlvbiBmKCkge1xuICByZXR1cm4gdGhpcy5fcHJvcGVydGllcy50YWJsZV9uYW1lO1xufTtcblxuQmFzZU1vZGVsLmlzX3RhYmxlX3JlYWR5ID0gZnVuY3Rpb24gZigpIHtcbiAgcmV0dXJuIHRoaXMuX3JlYWR5ID09PSB0cnVlO1xufTtcblxuQmFzZU1vZGVsLmluaXQgPSBmdW5jdGlvbiBmKG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gIGlmICghY2FsbGJhY2spIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHVuZGVmaW5lZDtcbiAgfVxuXG4gIHRoaXMuX3JlYWR5ID0gdHJ1ZTtcbiAgY2FsbGJhY2soKTtcbn07XG5cbkJhc2VNb2RlbC5zeW5jRGVmaW5pdGlvbiA9IGZ1bmN0aW9uIGYoY2FsbGJhY2spIHtcbiAgY29uc3QgYWZ0ZXJDcmVhdGUgPSAoZXJyLCByZXN1bHQpID0+IHtcbiAgICBpZiAoZXJyKSBjYWxsYmFjayhlcnIpO1xuICAgIGVsc2Uge1xuICAgICAgdGhpcy5fcmVhZHkgPSB0cnVlO1xuICAgICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0KTtcbiAgICB9XG4gIH07XG5cbiAgdGhpcy5fY3JlYXRlX3RhYmxlKGFmdGVyQ3JlYXRlKTtcbn07XG5cbkJhc2VNb2RlbC5leGVjdXRlX3F1ZXJ5ID0gZnVuY3Rpb24gZihxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMykge1xuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0ge307XG4gIH1cblxuICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgdGhpcy5fZW5zdXJlX2Nvbm5lY3RlZCgoZXJyKSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZGVidWcoJ2V4ZWN1dGluZyBxdWVyeTogJXMgd2l0aCBwYXJhbXM6ICVqJywgcXVlcnksIHBhcmFtcyk7XG4gICAgdGhpcy5fcHJvcGVydGllcy5jcWwuZXhlY3V0ZShxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCAoZXJyMSwgcmVzdWx0KSA9PiB7XG4gICAgICBpZiAoZXJyMSAmJiBlcnIxLmNvZGUgPT09IDg3MDQpIHtcbiAgICAgICAgdGhpcy5fZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5KHF1ZXJ5LCBwYXJhbXMsIGNhbGxiYWNrKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNhbGxiYWNrKGVycjEsIHJlc3VsdCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLmV4ZWN1dGVfZWFjaFJvdyA9IGZ1bmN0aW9uIGYocXVlcnksIHBhcmFtcywgb3B0aW9ucywgb25SZWFkYWJsZSwgY2FsbGJhY2spIHtcbiAgdGhpcy5fZW5zdXJlX2Nvbm5lY3RlZCgoZXJyKSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZGVidWcoJ2V4ZWN1dGluZyBlYWNoUm93IHF1ZXJ5OiAlcyB3aXRoIHBhcmFtczogJWonLCBxdWVyeSwgcGFyYW1zKTtcbiAgICB0aGlzLl9wcm9wZXJ0aWVzLmNxbC5lYWNoUm93KHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuX2V4ZWN1dGVfdGFibGVfZWFjaFJvdyA9IGZ1bmN0aW9uIGYocXVlcnksIHBhcmFtcywgb3B0aW9ucywgb25SZWFkYWJsZSwgY2FsbGJhY2spIHtcbiAgaWYgKHRoaXMuaXNfdGFibGVfcmVhZHkoKSkge1xuICAgIHRoaXMuZXhlY3V0ZV9lYWNoUm93KHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKTtcbiAgfSBlbHNlIHtcbiAgICB0aGlzLmluaXQoKGVycikgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0aGlzLmV4ZWN1dGVfZWFjaFJvdyhxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjayk7XG4gICAgfSk7XG4gIH1cbn07XG5cbkJhc2VNb2RlbC5lYWNoUm93ID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCwgb3B0aW9ucywgb25SZWFkYWJsZSwgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDMpIHtcbiAgICBjb25zdCBjYiA9IG9uUmVhZGFibGU7XG4gICAgb25SZWFkYWJsZSA9IG9wdGlvbnM7XG4gICAgY2FsbGJhY2sgPSBjYjtcbiAgICBvcHRpb25zID0ge307XG4gIH1cbiAgaWYgKHR5cGVvZiBvblJlYWRhYmxlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuZWFjaHJvd2Vycm9yJywgJ25vIHZhbGlkIG9uUmVhZGFibGUgZnVuY3Rpb24gd2FzIHByb3ZpZGVkJykpO1xuICB9XG4gIGlmICh0eXBlb2YgY2FsbGJhY2sgIT09ICdmdW5jdGlvbicpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5jYmVycm9yJykpO1xuICB9XG5cbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgcmF3OiBmYWxzZSxcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgb3B0aW9ucy5yZXR1cm5fcXVlcnkgPSB0cnVlO1xuICBjb25zdCBzZWxlY3RRdWVyeSA9IHRoaXMuZmluZChxdWVyeU9iamVjdCwgb3B0aW9ucyk7XG5cbiAgY29uc3QgcXVlcnlPcHRpb25zID0geyBwcmVwYXJlOiBvcHRpb25zLnByZXBhcmUgfTtcbiAgaWYgKG9wdGlvbnMuY29uc2lzdGVuY3kpIHF1ZXJ5T3B0aW9ucy5jb25zaXN0ZW5jeSA9IG9wdGlvbnMuY29uc2lzdGVuY3k7XG4gIGlmIChvcHRpb25zLmZldGNoU2l6ZSkgcXVlcnlPcHRpb25zLmZldGNoU2l6ZSA9IG9wdGlvbnMuZmV0Y2hTaXplO1xuICBpZiAob3B0aW9ucy5hdXRvUGFnZSkgcXVlcnlPcHRpb25zLmF1dG9QYWdlID0gb3B0aW9ucy5hdXRvUGFnZTtcbiAgaWYgKG9wdGlvbnMuaGludHMpIHF1ZXJ5T3B0aW9ucy5oaW50cyA9IG9wdGlvbnMuaGludHM7XG4gIGlmIChvcHRpb25zLnBhZ2VTdGF0ZSkgcXVlcnlPcHRpb25zLnBhZ2VTdGF0ZSA9IG9wdGlvbnMucGFnZVN0YXRlO1xuICBpZiAob3B0aW9ucy5yZXRyeSkgcXVlcnlPcHRpb25zLnJldHJ5ID0gb3B0aW9ucy5yZXRyeTtcbiAgaWYgKG9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3kpIHF1ZXJ5T3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeSA9IG9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3k7XG5cbiAgdGhpcy5fZXhlY3V0ZV90YWJsZV9lYWNoUm93KHNlbGVjdFF1ZXJ5LnF1ZXJ5LCBzZWxlY3RRdWVyeS5wYXJhbXMsIHF1ZXJ5T3B0aW9ucywgKG4sIHJvdykgPT4ge1xuICAgIGlmICghb3B0aW9ucy5yYXcpIHtcbiAgICAgIGNvbnN0IE1vZGVsQ29uc3RydWN0b3IgPSB0aGlzLl9wcm9wZXJ0aWVzLmdldF9jb25zdHJ1Y3RvcigpO1xuICAgICAgcm93ID0gbmV3IE1vZGVsQ29uc3RydWN0b3Iocm93KTtcbiAgICAgIHJvdy5fbW9kaWZpZWQgPSB7fTtcbiAgICB9XG4gICAgb25SZWFkYWJsZShuLCByb3cpO1xuICB9LCAoZXJyLCByZXN1bHQpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5maW5kLmRiZXJyb3InLCBlcnIpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY2FsbGJhY2soZXJyLCByZXN1bHQpO1xuICB9KTtcbn07XG5cbkJhc2VNb2RlbC5leGVjdXRlX3N0cmVhbSA9IGZ1bmN0aW9uIGYocXVlcnksIHBhcmFtcywgb3B0aW9ucywgb25SZWFkYWJsZSwgY2FsbGJhY2spIHtcbiAgdGhpcy5fZW5zdXJlX2Nvbm5lY3RlZCgoZXJyKSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZGVidWcoJ2V4ZWN1dGluZyBzdHJlYW0gcXVlcnk6ICVzIHdpdGggcGFyYW1zOiAlaicsIHF1ZXJ5LCBwYXJhbXMpO1xuICAgIHRoaXMuX3Byb3BlcnRpZXMuY3FsLnN0cmVhbShxdWVyeSwgcGFyYW1zLCBvcHRpb25zKS5vbigncmVhZGFibGUnLCBvblJlYWRhYmxlKS5vbignZW5kJywgY2FsbGJhY2spO1xuICB9KTtcbn07XG5cbkJhc2VNb2RlbC5fZXhlY3V0ZV90YWJsZV9zdHJlYW0gPSBmdW5jdGlvbiBmKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKSB7XG4gIGlmICh0aGlzLmlzX3RhYmxlX3JlYWR5KCkpIHtcbiAgICB0aGlzLmV4ZWN1dGVfc3RyZWFtKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKTtcbiAgfSBlbHNlIHtcbiAgICB0aGlzLmluaXQoKGVycikgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0aGlzLmV4ZWN1dGVfc3RyZWFtKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKTtcbiAgICB9KTtcbiAgfVxufTtcblxuQmFzZU1vZGVsLnN0cmVhbSA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKSB7XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAzKSB7XG4gICAgY29uc3QgY2IgPSBvblJlYWRhYmxlO1xuICAgIG9uUmVhZGFibGUgPSBvcHRpb25zO1xuICAgIGNhbGxiYWNrID0gY2I7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgaWYgKHR5cGVvZiBvblJlYWRhYmxlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuc3RyZWFtZXJyb3InLCAnbm8gdmFsaWQgb25SZWFkYWJsZSBmdW5jdGlvbiB3YXMgcHJvdmlkZWQnKSk7XG4gIH1cbiAgaWYgKHR5cGVvZiBjYWxsYmFjayAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmNiZXJyb3InKSk7XG4gIH1cblxuICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICByYXc6IGZhbHNlLFxuICAgIHByZXBhcmU6IHRydWUsXG4gIH07XG5cbiAgb3B0aW9ucyA9IF8uZGVmYXVsdHNEZWVwKG9wdGlvbnMsIGRlZmF1bHRzKTtcblxuICBvcHRpb25zLnJldHVybl9xdWVyeSA9IHRydWU7XG4gIGNvbnN0IHNlbGVjdFF1ZXJ5ID0gdGhpcy5maW5kKHF1ZXJ5T2JqZWN0LCBvcHRpb25zKTtcblxuICBjb25zdCBxdWVyeU9wdGlvbnMgPSB7IHByZXBhcmU6IG9wdGlvbnMucHJlcGFyZSB9O1xuICBpZiAob3B0aW9ucy5jb25zaXN0ZW5jeSkgcXVlcnlPcHRpb25zLmNvbnNpc3RlbmN5ID0gb3B0aW9ucy5jb25zaXN0ZW5jeTtcbiAgaWYgKG9wdGlvbnMuZmV0Y2hTaXplKSBxdWVyeU9wdGlvbnMuZmV0Y2hTaXplID0gb3B0aW9ucy5mZXRjaFNpemU7XG4gIGlmIChvcHRpb25zLmF1dG9QYWdlKSBxdWVyeU9wdGlvbnMuYXV0b1BhZ2UgPSBvcHRpb25zLmF1dG9QYWdlO1xuICBpZiAob3B0aW9ucy5oaW50cykgcXVlcnlPcHRpb25zLmhpbnRzID0gb3B0aW9ucy5oaW50cztcbiAgaWYgKG9wdGlvbnMucGFnZVN0YXRlKSBxdWVyeU9wdGlvbnMucGFnZVN0YXRlID0gb3B0aW9ucy5wYWdlU3RhdGU7XG4gIGlmIChvcHRpb25zLnJldHJ5KSBxdWVyeU9wdGlvbnMucmV0cnkgPSBvcHRpb25zLnJldHJ5O1xuICBpZiAob3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeSkgcXVlcnlPcHRpb25zLnNlcmlhbENvbnNpc3RlbmN5ID0gb3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeTtcblxuICBjb25zdCBzZWxmID0gdGhpcztcblxuICB0aGlzLl9leGVjdXRlX3RhYmxlX3N0cmVhbShzZWxlY3RRdWVyeS5xdWVyeSwgc2VsZWN0UXVlcnkucGFyYW1zLCBxdWVyeU9wdGlvbnMsIGZ1bmN0aW9uIGYxKCkge1xuICAgIGNvbnN0IHJlYWRlciA9IHRoaXM7XG4gICAgcmVhZGVyLnJlYWRSb3cgPSAoKSA9PiB7XG4gICAgICBjb25zdCByb3cgPSByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKCFyb3cpIHJldHVybiByb3c7XG4gICAgICBpZiAoIW9wdGlvbnMucmF3KSB7XG4gICAgICAgIGNvbnN0IE1vZGVsQ29uc3RydWN0b3IgPSBzZWxmLl9wcm9wZXJ0aWVzLmdldF9jb25zdHJ1Y3RvcigpO1xuICAgICAgICBjb25zdCBvID0gbmV3IE1vZGVsQ29uc3RydWN0b3Iocm93KTtcbiAgICAgICAgby5fbW9kaWZpZWQgPSB7fTtcbiAgICAgICAgcmV0dXJuIG87XG4gICAgICB9XG4gICAgICByZXR1cm4gcm93O1xuICAgIH07XG4gICAgb25SZWFkYWJsZShyZWFkZXIpO1xuICB9LCAoZXJyKSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZmluZC5kYmVycm9yJywgZXJyKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNhbGxiYWNrKCk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLmZpbmQgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0LCBvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMiAmJiB0eXBlb2Ygb3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0ge307XG4gIH1cbiAgaWYgKHR5cGVvZiBjYWxsYmFjayAhPT0gJ2Z1bmN0aW9uJyAmJiAhb3B0aW9ucy5yZXR1cm5fcXVlcnkpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5jYmVycm9yJykpO1xuICB9XG5cbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgcmF3OiBmYWxzZSxcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgLy8gc2V0IHJhdyB0cnVlIGlmIHNlbGVjdCBpcyB1c2VkLFxuICAvLyBiZWNhdXNlIGNhc3RpbmcgdG8gbW9kZWwgaW5zdGFuY2VzIG1heSBsZWFkIHRvIHByb2JsZW1zXG4gIGlmIChvcHRpb25zLnNlbGVjdCkgb3B0aW9ucy5yYXcgPSB0cnVlO1xuXG4gIGxldCBxdWVyeVBhcmFtcyA9IFtdO1xuXG4gIGxldCBxdWVyeTtcbiAgdHJ5IHtcbiAgICBjb25zdCBmaW5kUXVlcnkgPSB0aGlzLl9jcmVhdGVfZmluZF9xdWVyeShxdWVyeU9iamVjdCwgb3B0aW9ucyk7XG4gICAgcXVlcnkgPSBmaW5kUXVlcnkucXVlcnk7XG4gICAgcXVlcnlQYXJhbXMgPSBxdWVyeVBhcmFtcy5jb25jYXQoZmluZFF1ZXJ5LnBhcmFtcyk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBjYWxsYmFjayhlKTtcbiAgICAgIHJldHVybiB7fTtcbiAgICB9XG4gICAgdGhyb3cgKGUpO1xuICB9XG5cbiAgaWYgKG9wdGlvbnMucmV0dXJuX3F1ZXJ5KSB7XG4gICAgcmV0dXJuIHsgcXVlcnksIHBhcmFtczogcXVlcnlQYXJhbXMgfTtcbiAgfVxuXG4gIGNvbnN0IHF1ZXJ5T3B0aW9ucyA9IHsgcHJlcGFyZTogb3B0aW9ucy5wcmVwYXJlIH07XG4gIGlmIChvcHRpb25zLmNvbnNpc3RlbmN5KSBxdWVyeU9wdGlvbnMuY29uc2lzdGVuY3kgPSBvcHRpb25zLmNvbnNpc3RlbmN5O1xuICBpZiAob3B0aW9ucy5mZXRjaFNpemUpIHF1ZXJ5T3B0aW9ucy5mZXRjaFNpemUgPSBvcHRpb25zLmZldGNoU2l6ZTtcbiAgaWYgKG9wdGlvbnMuYXV0b1BhZ2UpIHF1ZXJ5T3B0aW9ucy5hdXRvUGFnZSA9IG9wdGlvbnMuYXV0b1BhZ2U7XG4gIGlmIChvcHRpb25zLmhpbnRzKSBxdWVyeU9wdGlvbnMuaGludHMgPSBvcHRpb25zLmhpbnRzO1xuICBpZiAob3B0aW9ucy5wYWdlU3RhdGUpIHF1ZXJ5T3B0aW9ucy5wYWdlU3RhdGUgPSBvcHRpb25zLnBhZ2VTdGF0ZTtcbiAgaWYgKG9wdGlvbnMucmV0cnkpIHF1ZXJ5T3B0aW9ucy5yZXRyeSA9IG9wdGlvbnMucmV0cnk7XG4gIGlmIChvcHRpb25zLnNlcmlhbENvbnNpc3RlbmN5KSBxdWVyeU9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3kgPSBvcHRpb25zLnNlcmlhbENvbnNpc3RlbmN5O1xuXG4gIHRoaXMuX2V4ZWN1dGVfdGFibGVfcXVlcnkocXVlcnksIHF1ZXJ5UGFyYW1zLCBxdWVyeU9wdGlvbnMsIChlcnIsIHJlc3VsdHMpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5maW5kLmRiZXJyb3InLCBlcnIpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKCFvcHRpb25zLnJhdykge1xuICAgICAgY29uc3QgTW9kZWxDb25zdHJ1Y3RvciA9IHRoaXMuX3Byb3BlcnRpZXMuZ2V0X2NvbnN0cnVjdG9yKCk7XG4gICAgICByZXN1bHRzID0gcmVzdWx0cy5yb3dzLm1hcCgocmVzKSA9PiB7XG4gICAgICAgIGRlbGV0ZSAocmVzLmNvbHVtbnMpO1xuICAgICAgICBjb25zdCBvID0gbmV3IE1vZGVsQ29uc3RydWN0b3IocmVzKTtcbiAgICAgICAgby5fbW9kaWZpZWQgPSB7fTtcbiAgICAgICAgcmV0dXJuIG87XG4gICAgICB9KTtcbiAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdHMpO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXN1bHRzID0gcmVzdWx0cy5yb3dzLm1hcCgocmVzKSA9PiB7XG4gICAgICAgIGRlbGV0ZSAocmVzLmNvbHVtbnMpO1xuICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgfSk7XG4gICAgICBjYWxsYmFjayhudWxsLCByZXN1bHRzKTtcbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiB7fTtcbn07XG5cbkJhc2VNb2RlbC5maW5kT25lID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCwgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDIgJiYgdHlwZW9mIG9wdGlvbnMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG4gIGlmICh0eXBlb2YgY2FsbGJhY2sgIT09ICdmdW5jdGlvbicgJiYgIW9wdGlvbnMucmV0dXJuX3F1ZXJ5KSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuY2JlcnJvcicpKTtcbiAgfVxuXG4gIHF1ZXJ5T2JqZWN0LiRsaW1pdCA9IDE7XG5cbiAgcmV0dXJuIHRoaXMuZmluZChxdWVyeU9iamVjdCwgb3B0aW9ucywgKGVyciwgcmVzdWx0cykgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdHNbMF0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjYWxsYmFjaygpO1xuICB9KTtcbn07XG5cbkJhc2VNb2RlbC51cGRhdGUgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0LCB1cGRhdGVWYWx1ZXMsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAzICYmIHR5cGVvZiBvcHRpb25zID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgIG9wdGlvbnMgPSB7fTtcbiAgfVxuXG4gIGNvbnN0IHNjaGVtYSA9IHRoaXMuX3Byb3BlcnRpZXMuc2NoZW1hO1xuXG4gIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgIHByZXBhcmU6IHRydWUsXG4gIH07XG5cbiAgb3B0aW9ucyA9IF8uZGVmYXVsdHNEZWVwKG9wdGlvbnMsIGRlZmF1bHRzKTtcblxuICBsZXQgcXVlcnlQYXJhbXMgPSBbXTtcblxuICBjb25zdCB1cGRhdGVDbGF1c2VBcnJheSA9IFtdO1xuXG4gIGNvbnN0IGVycm9ySGFwcGVuZWQgPSBPYmplY3Qua2V5cyh1cGRhdGVWYWx1ZXMpLnNvbWUoKGtleSkgPT4ge1xuICAgIGlmIChzY2hlbWEuZmllbGRzW2tleV0gPT09IHVuZGVmaW5lZCB8fCBzY2hlbWEuZmllbGRzW2tleV0udmlydHVhbCkgcmV0dXJuIGZhbHNlO1xuXG4gICAgLy8gY2hlY2sgZmllbGQgdmFsdWVcbiAgICBjb25zdCBmaWVsZHR5cGUgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHNjaGVtYSwga2V5KTtcbiAgICBsZXQgZmllbGR2YWx1ZSA9IHVwZGF0ZVZhbHVlc1trZXldO1xuXG4gICAgaWYgKGZpZWxkdmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZmllbGR2YWx1ZSA9IHRoaXMuX2dldF9kZWZhdWx0X3ZhbHVlKGtleSk7XG4gICAgICBpZiAoZmllbGR2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGlmIChzY2hlbWEua2V5LmluZGV4T2Yoa2V5KSA+PSAwIHx8IHNjaGVtYS5rZXlbMF0uaW5kZXhPZihrZXkpID49IDApIHtcbiAgICAgICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC51cGRhdGUudW5zZXRrZXknLCBrZXkpKTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLnVuc2V0a2V5Jywga2V5KSk7XG4gICAgICAgIH0gZWxzZSBpZiAoc2NoZW1hLmZpZWxkc1trZXldLnJ1bGUgJiYgc2NoZW1hLmZpZWxkc1trZXldLnJ1bGUucmVxdWlyZWQpIHtcbiAgICAgICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC51cGRhdGUudW5zZXRyZXF1aXJlZCcsIGtleSkpO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC51cGRhdGUudW5zZXRyZXF1aXJlZCcsIGtleSkpO1xuICAgICAgICB9IGVsc2UgcmV0dXJuIGZhbHNlO1xuICAgICAgfSBlbHNlIGlmICghc2NoZW1hLmZpZWxkc1trZXldLnJ1bGUgfHwgIXNjaGVtYS5maWVsZHNba2V5XS5ydWxlLmlnbm9yZV9kZWZhdWx0KSB7XG4gICAgICAgIC8vIGRpZCBzZXQgYSBkZWZhdWx0IHZhbHVlLCBpZ25vcmUgZGVmYXVsdCBpcyBub3Qgc2V0XG4gICAgICAgIGlmICh0aGlzLnZhbGlkYXRlKGtleSwgZmllbGR2YWx1ZSkgIT09IHRydWUpIHtcbiAgICAgICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuaW52YWxpZGRlZmF1bHR2YWx1ZScsIGZpZWxkdmFsdWUsIGtleSwgZmllbGR0eXBlKSk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS5pbnZhbGlkZGVmYXVsdHZhbHVlJywgZmllbGR2YWx1ZSwga2V5LCBmaWVsZHR5cGUpKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChmaWVsZHZhbHVlID09PSBudWxsIHx8IGZpZWxkdmFsdWUgPT09IGNxbC50eXBlcy51bnNldCkge1xuICAgICAgaWYgKHNjaGVtYS5rZXkuaW5kZXhPZihrZXkpID49IDAgfHwgc2NoZW1hLmtleVswXS5pbmRleE9mKGtleSkgPj0gMCkge1xuICAgICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLnVuc2V0a2V5Jywga2V5KSk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS51bnNldGtleScsIGtleSkpO1xuICAgICAgfSBlbHNlIGlmIChzY2hlbWEuZmllbGRzW2tleV0ucnVsZSAmJiBzY2hlbWEuZmllbGRzW2tleV0ucnVsZS5yZXF1aXJlZCkge1xuICAgICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLnVuc2V0cmVxdWlyZWQnLCBrZXkpKTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLnVuc2V0cmVxdWlyZWQnLCBrZXkpKTtcbiAgICAgIH1cbiAgICB9XG5cblxuICAgIHRyeSB7XG4gICAgICBsZXQgJGFkZCA9IGZhbHNlO1xuICAgICAgbGV0ICRhcHBlbmQgPSBmYWxzZTtcbiAgICAgIGxldCAkcHJlcGVuZCA9IGZhbHNlO1xuICAgICAgbGV0ICRyZXBsYWNlID0gZmFsc2U7XG4gICAgICBsZXQgJHJlbW92ZSA9IGZhbHNlO1xuICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChmaWVsZHZhbHVlKSkge1xuICAgICAgICBpZiAoZmllbGR2YWx1ZS4kYWRkKSB7XG4gICAgICAgICAgZmllbGR2YWx1ZSA9IGZpZWxkdmFsdWUuJGFkZDtcbiAgICAgICAgICAkYWRkID0gdHJ1ZTtcbiAgICAgICAgfSBlbHNlIGlmIChmaWVsZHZhbHVlLiRhcHBlbmQpIHtcbiAgICAgICAgICBmaWVsZHZhbHVlID0gZmllbGR2YWx1ZS4kYXBwZW5kO1xuICAgICAgICAgICRhcHBlbmQgPSB0cnVlO1xuICAgICAgICB9IGVsc2UgaWYgKGZpZWxkdmFsdWUuJHByZXBlbmQpIHtcbiAgICAgICAgICBmaWVsZHZhbHVlID0gZmllbGR2YWx1ZS4kcHJlcGVuZDtcbiAgICAgICAgICAkcHJlcGVuZCA9IHRydWU7XG4gICAgICAgIH0gZWxzZSBpZiAoZmllbGR2YWx1ZS4kcmVwbGFjZSkge1xuICAgICAgICAgIGZpZWxkdmFsdWUgPSBmaWVsZHZhbHVlLiRyZXBsYWNlO1xuICAgICAgICAgICRyZXBsYWNlID0gdHJ1ZTtcbiAgICAgICAgfSBlbHNlIGlmIChmaWVsZHZhbHVlLiRyZW1vdmUpIHtcbiAgICAgICAgICBmaWVsZHZhbHVlID0gZmllbGR2YWx1ZS4kcmVtb3ZlO1xuICAgICAgICAgICRyZW1vdmUgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGRiVmFsID0gdGhpcy5fZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24oa2V5LCBmaWVsZHZhbHVlKTtcblxuICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkYlZhbCkgJiYgZGJWYWwucXVlcnlfc2VnbWVudCkge1xuICAgICAgICBpZiAoWydtYXAnLCAnbGlzdCcsICdzZXQnXS5pbmRleE9mKGZpZWxkdHlwZSkgPiAtMSkge1xuICAgICAgICAgIGlmICgkYWRkIHx8ICRhcHBlbmQpIHtcbiAgICAgICAgICAgIGRiVmFsLnF1ZXJ5X3NlZ21lbnQgPSB1dGlsLmZvcm1hdCgnXCIlc1wiICsgJXMnLCBrZXksIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpO1xuICAgICAgICAgIH0gZWxzZSBpZiAoJHByZXBlbmQpIHtcbiAgICAgICAgICAgIGlmIChmaWVsZHR5cGUgPT09ICdsaXN0Jykge1xuICAgICAgICAgICAgICBkYlZhbC5xdWVyeV9zZWdtZW50ID0gdXRpbC5mb3JtYXQoJyVzICsgXCIlc1wiJywgZGJWYWwucXVlcnlfc2VnbWVudCwga2V5KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHRocm93IChidWlsZEVycm9yKFxuICAgICAgICAgICAgICAgICdtb2RlbC51cGRhdGUuaW52YWxpZHByZXBlbmRvcCcsXG4gICAgICAgICAgICAgICAgdXRpbC5mb3JtYXQoJyVzIGRhdGF0eXBlcyBkb2VzIG5vdCBzdXBwb3J0ICRwcmVwZW5kLCB1c2UgJGFkZCBpbnN0ZWFkJywgZmllbGR0eXBlKSxcbiAgICAgICAgICAgICAgKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIGlmICgkcmVtb3ZlKSB7XG4gICAgICAgICAgICBkYlZhbC5xdWVyeV9zZWdtZW50ID0gdXRpbC5mb3JtYXQoJ1wiJXNcIiAtICVzJywga2V5LCBkYlZhbC5xdWVyeV9zZWdtZW50KTtcbiAgICAgICAgICAgIGlmIChmaWVsZHR5cGUgPT09ICdtYXAnKSBkYlZhbC5wYXJhbWV0ZXIgPSBPYmplY3Qua2V5cyhkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkcmVwbGFjZSkge1xuICAgICAgICAgIGlmIChmaWVsZHR5cGUgPT09ICdtYXAnKSB7XG4gICAgICAgICAgICB1cGRhdGVDbGF1c2VBcnJheS5wdXNoKHV0aWwuZm9ybWF0KCdcIiVzXCJbP109JXMnLCBrZXksIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpKTtcbiAgICAgICAgICAgIGNvbnN0IHJlcGxhY2VLZXlzID0gT2JqZWN0LmtleXMoZGJWYWwucGFyYW1ldGVyKTtcbiAgICAgICAgICAgIGNvbnN0IHJlcGxhY2VWYWx1ZXMgPSBfLnZhbHVlcyhkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgICAgICAgaWYgKHJlcGxhY2VLZXlzLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKHJlcGxhY2VLZXlzWzBdKTtcbiAgICAgICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChyZXBsYWNlVmFsdWVzWzBdKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHRocm93IChcbiAgICAgICAgICAgICAgICBidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuaW52YWxpZHJlcGxhY2VvcCcsICckcmVwbGFjZSBpbiBtYXAgZG9lcyBub3Qgc3VwcG9ydCBtb3JlIHRoYW4gb25lIGl0ZW0nKVxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGR0eXBlID09PSAnbGlzdCcpIHtcbiAgICAgICAgICAgIHVwZGF0ZUNsYXVzZUFycmF5LnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIls/XT0lcycsIGtleSwgZGJWYWwucXVlcnlfc2VnbWVudCkpO1xuICAgICAgICAgICAgaWYgKGRiVmFsLnBhcmFtZXRlci5sZW5ndGggPT09IDIpIHtcbiAgICAgICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXJbMF0pO1xuICAgICAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlclsxXSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcihcbiAgICAgICAgICAgICAgICAnbW9kZWwudXBkYXRlLmludmFsaWRyZXBsYWNlb3AnLFxuICAgICAgICAgICAgICAgICckcmVwbGFjZSBpbiBsaXN0IHNob3VsZCBoYXZlIGV4YWN0bHkgMiBpdGVtcywgZmlyc3Qgb25lIGFzIHRoZSBpbmRleCBhbmQgdGhlIHNlY29uZCBvbmUgYXMgdGhlIHZhbHVlJyxcbiAgICAgICAgICAgICAgKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IChidWlsZEVycm9yKFxuICAgICAgICAgICAgICAnbW9kZWwudXBkYXRlLmludmFsaWRyZXBsYWNlb3AnLFxuICAgICAgICAgICAgICB1dGlsLmZvcm1hdCgnJXMgZGF0YXR5cGVzIGRvZXMgbm90IHN1cHBvcnQgJHJlcGxhY2UnLCBmaWVsZHR5cGUpLFxuICAgICAgICAgICAgKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHVwZGF0ZUNsYXVzZUFycmF5LnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIj0lcycsIGtleSwgZGJWYWwucXVlcnlfc2VnbWVudCkpO1xuICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdXBkYXRlQ2xhdXNlQXJyYXkucHVzaCh1dGlsLmZvcm1hdCgnXCIlc1wiPSVzJywga2V5LCBkYlZhbCkpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgY2FsbGJhY2soZSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgICAgdGhyb3cgKGUpO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH0pO1xuXG4gIGlmIChlcnJvckhhcHBlbmVkKSByZXR1cm4ge307XG5cbiAgbGV0IHF1ZXJ5ID0gJ1VQREFURSBcIiVzXCInO1xuICBsZXQgd2hlcmUgPSAnJztcbiAgaWYgKG9wdGlvbnMudHRsKSBxdWVyeSArPSB1dGlsLmZvcm1hdCgnIFVTSU5HIFRUTCAlcycsIG9wdGlvbnMudHRsKTtcbiAgcXVlcnkgKz0gJyBTRVQgJXMgJXMnO1xuICB0cnkge1xuICAgIGNvbnN0IHdoZXJlQ2xhdXNlID0gdGhpcy5fY3JlYXRlX3doZXJlX2NsYXVzZShxdWVyeU9iamVjdCk7XG4gICAgd2hlcmUgPSB3aGVyZUNsYXVzZS5xdWVyeTtcbiAgICBxdWVyeVBhcmFtcyA9IHF1ZXJ5UGFyYW1zLmNvbmNhdCh3aGVyZUNsYXVzZS5wYXJhbXMpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgY2FsbGJhY2soZSk7XG4gICAgICByZXR1cm4ge307XG4gICAgfVxuICAgIHRocm93IChlKTtcbiAgfVxuICBxdWVyeSA9IHV0aWwuZm9ybWF0KHF1ZXJ5LCB0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWUsIHVwZGF0ZUNsYXVzZUFycmF5LmpvaW4oJywgJyksIHdoZXJlKTtcblxuICBpZiAob3B0aW9ucy5jb25kaXRpb25zKSB7XG4gICAgY29uc3QgaWZDbGF1c2UgPSB0aGlzLl9jcmVhdGVfaWZfY2xhdXNlKG9wdGlvbnMuY29uZGl0aW9ucyk7XG4gICAgaWYgKGlmQ2xhdXNlLnF1ZXJ5KSB7XG4gICAgICBxdWVyeSArPSB1dGlsLmZvcm1hdCgnICVzJywgaWZDbGF1c2UucXVlcnkpO1xuICAgICAgcXVlcnlQYXJhbXMgPSBxdWVyeVBhcmFtcy5jb25jYXQoaWZDbGF1c2UucGFyYW1zKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAob3B0aW9ucy5pZl9leGlzdHMpIHtcbiAgICBxdWVyeSArPSAnIElGIEVYSVNUUyc7XG4gIH1cblxuICBxdWVyeSArPSAnOyc7XG5cbiAgLy8gc2V0IGR1bW15IGhvb2sgZnVuY3Rpb24gaWYgbm90IHByZXNlbnQgaW4gc2NoZW1hXG4gIGlmICh0eXBlb2Ygc2NoZW1hLmJlZm9yZV91cGRhdGUgIT09ICdmdW5jdGlvbicpIHtcbiAgICBzY2hlbWEuYmVmb3JlX3VwZGF0ZSA9IGZ1bmN0aW9uIGYxKHF1ZXJ5T2JqLCB1cGRhdGVWYWwsIG9wdGlvbnNPYmosIG5leHQpIHtcbiAgICAgIG5leHQoKTtcbiAgICB9O1xuICB9XG5cbiAgaWYgKHR5cGVvZiBzY2hlbWEuYWZ0ZXJfdXBkYXRlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgc2NoZW1hLmFmdGVyX3VwZGF0ZSA9IGZ1bmN0aW9uIGYxKHF1ZXJ5T2JqLCB1cGRhdGVWYWwsIG9wdGlvbnNPYmosIG5leHQpIHtcbiAgICAgIG5leHQoKTtcbiAgICB9O1xuICB9XG5cbiAgZnVuY3Rpb24gaG9va1J1bm5lcihmbiwgZXJyb3JDb2RlKSB7XG4gICAgcmV0dXJuIChob29rQ2FsbGJhY2spID0+IHtcbiAgICAgIGZuKHF1ZXJ5T2JqZWN0LCB1cGRhdGVWYWx1ZXMsIG9wdGlvbnMsIChlcnJvcikgPT4ge1xuICAgICAgICBpZiAoZXJyb3IpIHtcbiAgICAgICAgICBob29rQ2FsbGJhY2soYnVpbGRFcnJvcihlcnJvckNvZGUsIGVycm9yKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGhvb2tDYWxsYmFjaygpO1xuICAgICAgfSk7XG4gICAgfTtcbiAgfVxuXG4gIGlmIChvcHRpb25zLnJldHVybl9xdWVyeSkge1xuICAgIHJldHVybiB7XG4gICAgICBxdWVyeSxcbiAgICAgIHBhcmFtczogcXVlcnlQYXJhbXMsXG4gICAgICBiZWZvcmVfaG9vazogaG9va1J1bm5lcihzY2hlbWEuYmVmb3JlX3VwZGF0ZSwgJ21vZGVsLnVwZGF0ZS5iZWZvcmUuZXJyb3InKSxcbiAgICAgIGFmdGVyX2hvb2s6IGhvb2tSdW5uZXIoc2NoZW1hLmFmdGVyX3VwZGF0ZSwgJ21vZGVsLnVwZGF0ZS5hZnRlci5lcnJvcicpLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBxdWVyeU9wdGlvbnMgPSB7IHByZXBhcmU6IG9wdGlvbnMucHJlcGFyZSB9O1xuICBpZiAob3B0aW9ucy5jb25zaXN0ZW5jeSkgcXVlcnlPcHRpb25zLmNvbnNpc3RlbmN5ID0gb3B0aW9ucy5jb25zaXN0ZW5jeTtcbiAgaWYgKG9wdGlvbnMuZmV0Y2hTaXplKSBxdWVyeU9wdGlvbnMuZmV0Y2hTaXplID0gb3B0aW9ucy5mZXRjaFNpemU7XG4gIGlmIChvcHRpb25zLmF1dG9QYWdlKSBxdWVyeU9wdGlvbnMuYXV0b1BhZ2UgPSBvcHRpb25zLmF1dG9QYWdlO1xuICBpZiAob3B0aW9ucy5oaW50cykgcXVlcnlPcHRpb25zLmhpbnRzID0gb3B0aW9ucy5oaW50cztcbiAgaWYgKG9wdGlvbnMucGFnZVN0YXRlKSBxdWVyeU9wdGlvbnMucGFnZVN0YXRlID0gb3B0aW9ucy5wYWdlU3RhdGU7XG4gIGlmIChvcHRpb25zLnJldHJ5KSBxdWVyeU9wdGlvbnMucmV0cnkgPSBvcHRpb25zLnJldHJ5O1xuICBpZiAob3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeSkgcXVlcnlPcHRpb25zLnNlcmlhbENvbnNpc3RlbmN5ID0gb3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeTtcblxuICBzY2hlbWEuYmVmb3JlX3VwZGF0ZShxdWVyeU9iamVjdCwgdXBkYXRlVmFsdWVzLCBvcHRpb25zLCAoZXJyb3IpID0+IHtcbiAgICBpZiAoZXJyb3IpIHtcbiAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmJlZm9yZS5lcnJvcicsIGVycm9yKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuYmVmb3JlLmVycm9yJywgZXJyb3IpKTtcbiAgICB9XG5cbiAgICB0aGlzLl9leGVjdXRlX3RhYmxlX3F1ZXJ5KHF1ZXJ5LCBxdWVyeVBhcmFtcywgcXVlcnlPcHRpb25zLCAoZXJyLCByZXN1bHRzKSA9PiB7XG4gICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuZGJlcnJvcicsIGVycikpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBzY2hlbWEuYWZ0ZXJfdXBkYXRlKHF1ZXJ5T2JqZWN0LCB1cGRhdGVWYWx1ZXMsIG9wdGlvbnMsIChlcnJvcjEpID0+IHtcbiAgICAgICAgICBpZiAoZXJyb3IxKSB7XG4gICAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuYWZ0ZXIuZXJyb3InLCBlcnJvcjEpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0cyk7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIGlmIChlcnIpIHtcbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS5kYmVycm9yJywgZXJyKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzY2hlbWEuYWZ0ZXJfdXBkYXRlKHF1ZXJ5T2JqZWN0LCB1cGRhdGVWYWx1ZXMsIG9wdGlvbnMsIChlcnJvcjEpID0+IHtcbiAgICAgICAgICBpZiAoZXJyb3IxKSB7XG4gICAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmFmdGVyLmVycm9yJywgZXJyb3IxKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSk7XG5cbiAgcmV0dXJuIHt9O1xufTtcblxuQmFzZU1vZGVsLmRlbGV0ZSA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAyICYmIHR5cGVvZiBvcHRpb25zID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgIG9wdGlvbnMgPSB7fTtcbiAgfVxuXG4gIGNvbnN0IHNjaGVtYSA9IHRoaXMuX3Byb3BlcnRpZXMuc2NoZW1hO1xuXG4gIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgIHByZXBhcmU6IHRydWUsXG4gIH07XG5cbiAgb3B0aW9ucyA9IF8uZGVmYXVsdHNEZWVwKG9wdGlvbnMsIGRlZmF1bHRzKTtcblxuICBsZXQgcXVlcnlQYXJhbXMgPSBbXTtcblxuICBsZXQgcXVlcnkgPSAnREVMRVRFIEZST00gXCIlc1wiICVzOyc7XG4gIGxldCB3aGVyZSA9ICcnO1xuICB0cnkge1xuICAgIGNvbnN0IHdoZXJlQ2xhdXNlID0gdGhpcy5fY3JlYXRlX3doZXJlX2NsYXVzZShxdWVyeU9iamVjdCk7XG4gICAgd2hlcmUgPSB3aGVyZUNsYXVzZS5xdWVyeTtcbiAgICBxdWVyeVBhcmFtcyA9IHF1ZXJ5UGFyYW1zLmNvbmNhdCh3aGVyZUNsYXVzZS5wYXJhbXMpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgY2FsbGJhY2soZSk7XG4gICAgICByZXR1cm4ge307XG4gICAgfVxuICAgIHRocm93IChlKTtcbiAgfVxuXG4gIHF1ZXJ5ID0gdXRpbC5mb3JtYXQocXVlcnksIHRoaXMuX3Byb3BlcnRpZXMudGFibGVfbmFtZSwgd2hlcmUpO1xuXG4gIC8vIHNldCBkdW1teSBob29rIGZ1bmN0aW9uIGlmIG5vdCBwcmVzZW50IGluIHNjaGVtYVxuICBpZiAodHlwZW9mIHNjaGVtYS5iZWZvcmVfZGVsZXRlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgc2NoZW1hLmJlZm9yZV9kZWxldGUgPSBmdW5jdGlvbiBmMShxdWVyeU9iaiwgb3B0aW9uc09iaiwgbmV4dCkge1xuICAgICAgbmV4dCgpO1xuICAgIH07XG4gIH1cblxuICBpZiAodHlwZW9mIHNjaGVtYS5hZnRlcl9kZWxldGUgIT09ICdmdW5jdGlvbicpIHtcbiAgICBzY2hlbWEuYWZ0ZXJfZGVsZXRlID0gZnVuY3Rpb24gZjEocXVlcnlPYmosIG9wdGlvbnNPYmosIG5leHQpIHtcbiAgICAgIG5leHQoKTtcbiAgICB9O1xuICB9XG5cbiAgaWYgKG9wdGlvbnMucmV0dXJuX3F1ZXJ5KSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHF1ZXJ5LFxuICAgICAgcGFyYW1zOiBxdWVyeVBhcmFtcyxcbiAgICAgIGJlZm9yZV9ob29rOiAoaG9va0NhbGxiYWNrKSA9PiB7XG4gICAgICAgIHNjaGVtYS5iZWZvcmVfZGVsZXRlKHF1ZXJ5T2JqZWN0LCBvcHRpb25zLCAoZXJyb3IpID0+IHtcbiAgICAgICAgICBpZiAoZXJyb3IpIHtcbiAgICAgICAgICAgIGhvb2tDYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5kZWxldGUuYmVmb3JlLmVycm9yJywgZXJyb3IpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgaG9va0NhbGxiYWNrKCk7XG4gICAgICAgIH0pO1xuICAgICAgfSxcbiAgICAgIGFmdGVyX2hvb2s6IChob29rQ2FsbGJhY2spID0+IHtcbiAgICAgICAgc2NoZW1hLmFmdGVyX2RlbGV0ZShxdWVyeU9iamVjdCwgb3B0aW9ucywgKGVycm9yKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgICBob29rQ2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZGVsZXRlLmFmdGVyLmVycm9yJywgZXJyb3IpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgaG9va0NhbGxiYWNrKCk7XG4gICAgICAgIH0pO1xuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgcXVlcnlPcHRpb25zID0geyBwcmVwYXJlOiBvcHRpb25zLnByZXBhcmUgfTtcbiAgaWYgKG9wdGlvbnMuY29uc2lzdGVuY3kpIHF1ZXJ5T3B0aW9ucy5jb25zaXN0ZW5jeSA9IG9wdGlvbnMuY29uc2lzdGVuY3k7XG4gIGlmIChvcHRpb25zLmZldGNoU2l6ZSkgcXVlcnlPcHRpb25zLmZldGNoU2l6ZSA9IG9wdGlvbnMuZmV0Y2hTaXplO1xuICBpZiAob3B0aW9ucy5hdXRvUGFnZSkgcXVlcnlPcHRpb25zLmF1dG9QYWdlID0gb3B0aW9ucy5hdXRvUGFnZTtcbiAgaWYgKG9wdGlvbnMuaGludHMpIHF1ZXJ5T3B0aW9ucy5oaW50cyA9IG9wdGlvbnMuaGludHM7XG4gIGlmIChvcHRpb25zLnBhZ2VTdGF0ZSkgcXVlcnlPcHRpb25zLnBhZ2VTdGF0ZSA9IG9wdGlvbnMucGFnZVN0YXRlO1xuICBpZiAob3B0aW9ucy5yZXRyeSkgcXVlcnlPcHRpb25zLnJldHJ5ID0gb3B0aW9ucy5yZXRyeTtcbiAgaWYgKG9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3kpIHF1ZXJ5T3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeSA9IG9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3k7XG5cbiAgc2NoZW1hLmJlZm9yZV9kZWxldGUocXVlcnlPYmplY3QsIG9wdGlvbnMsIChlcnJvcikgPT4ge1xuICAgIGlmIChlcnJvcikge1xuICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5kZWxldGUuYmVmb3JlLmVycm9yJywgZXJyb3IpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmRlbGV0ZS5iZWZvcmUuZXJyb3InLCBlcnJvcikpO1xuICAgIH1cblxuICAgIHRoaXMuX2V4ZWN1dGVfdGFibGVfcXVlcnkocXVlcnksIHF1ZXJ5UGFyYW1zLCBxdWVyeU9wdGlvbnMsIChlcnIsIHJlc3VsdHMpID0+IHtcbiAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLmRlbGV0ZS5kYmVycm9yJywgZXJyKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHNjaGVtYS5hZnRlcl9kZWxldGUocXVlcnlPYmplY3QsIG9wdGlvbnMsIChlcnJvcjEpID0+IHtcbiAgICAgICAgICBpZiAoZXJyb3IxKSB7XG4gICAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5kZWxldGUuYWZ0ZXIuZXJyb3InLCBlcnJvcjEpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0cyk7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIGlmIChlcnIpIHtcbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmRlbGV0ZS5kYmVycm9yJywgZXJyKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzY2hlbWEuYWZ0ZXJfZGVsZXRlKHF1ZXJ5T2JqZWN0LCBvcHRpb25zLCAoZXJyb3IxKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yMSkge1xuICAgICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmRlbGV0ZS5hZnRlci5lcnJvcicsIGVycm9yMSkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xuXG4gIHJldHVybiB7fTtcbn07XG5cbkJhc2VNb2RlbC50cnVuY2F0ZSA9IGZ1bmN0aW9uIGYoY2FsbGJhY2spIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BlcnRpZXMudGFibGVfbmFtZTtcblxuICBjb25zdCBxdWVyeSA9IHV0aWwuZm9ybWF0KCdUUlVOQ0FURSBUQUJMRSBcIiVzXCI7JywgdGFibGVOYW1lKTtcbiAgdGhpcy5fZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5KHF1ZXJ5LCBbXSwgY2FsbGJhY2spO1xufTtcblxuQmFzZU1vZGVsLmRyb3BfbXZpZXdzID0gZnVuY3Rpb24gZihtdmlld3MsIGNhbGxiYWNrKSB7XG4gIGFzeW5jLmVhY2gobXZpZXdzLCAodmlldywgdmlld0NhbGxiYWNrKSA9PiB7XG4gICAgY29uc3QgcXVlcnkgPSB1dGlsLmZvcm1hdCgnRFJPUCBNQVRFUklBTElaRUQgVklFVyBJRiBFWElTVFMgXCIlc1wiOycsIHZpZXcpO1xuICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShxdWVyeSwgW10sIHZpZXdDYWxsYmFjayk7XG4gIH0sIChlcnIpID0+IHtcbiAgICBpZiAoZXJyKSBjYWxsYmFjayhlcnIpO1xuICAgIGVsc2UgY2FsbGJhY2soKTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuZHJvcF9pbmRleGVzID0gZnVuY3Rpb24gZihpbmRleGVzLCBjYWxsYmFjaykge1xuICBhc3luYy5lYWNoKGluZGV4ZXMsIChpbmRleCwgaW5kZXhDYWxsYmFjaykgPT4ge1xuICAgIGNvbnN0IHF1ZXJ5ID0gdXRpbC5mb3JtYXQoJ0RST1AgSU5ERVggSUYgRVhJU1RTIFwiJXNcIjsnLCBpbmRleCk7XG4gICAgdGhpcy5fZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5KHF1ZXJ5LCBbXSwgaW5kZXhDYWxsYmFjayk7XG4gIH0sIChlcnIpID0+IHtcbiAgICBpZiAoZXJyKSBjYWxsYmFjayhlcnIpO1xuICAgIGVsc2UgY2FsbGJhY2soKTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuYWx0ZXJfdGFibGUgPSBmdW5jdGlvbiBmKG9wZXJhdGlvbiwgZmllbGRuYW1lLCB0eXBlLCBjYWxsYmFjaykge1xuICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5fcHJvcGVydGllcztcbiAgY29uc3QgdGFibGVOYW1lID0gcHJvcGVydGllcy50YWJsZV9uYW1lO1xuXG4gIGlmIChvcGVyYXRpb24gPT09ICdBTFRFUicpIHR5cGUgPSB1dGlsLmZvcm1hdCgnVFlQRSAlcycsIHR5cGUpO1xuICBlbHNlIGlmIChvcGVyYXRpb24gPT09ICdEUk9QJykgdHlwZSA9ICcnO1xuXG4gIGNvbnN0IHF1ZXJ5ID0gdXRpbC5mb3JtYXQoJ0FMVEVSIFRBQkxFIFwiJXNcIiAlcyBcIiVzXCIgJXM7JywgdGFibGVOYW1lLCBvcGVyYXRpb24sIGZpZWxkbmFtZSwgdHlwZSk7XG4gIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShxdWVyeSwgW10sIGNhbGxiYWNrKTtcbn07XG5cbkJhc2VNb2RlbC5kcm9wX3RhYmxlID0gZnVuY3Rpb24gZihjYWxsYmFjaykge1xuICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5fcHJvcGVydGllcztcbiAgY29uc3QgdGFibGVOYW1lID0gcHJvcGVydGllcy50YWJsZV9uYW1lO1xuXG4gIGNvbnN0IHF1ZXJ5ID0gdXRpbC5mb3JtYXQoJ0RST1AgVEFCTEUgSUYgRVhJU1RTIFwiJXNcIjsnLCB0YWJsZU5hbWUpO1xuICB0aGlzLl9leGVjdXRlX2RlZmluaXRpb25fcXVlcnkocXVlcnksIFtdLCBjYWxsYmFjayk7XG59O1xuXG5CYXNlTW9kZWwucHJvdG90eXBlLl9nZXRfZGF0YV90eXBlcyA9IGZ1bmN0aW9uIGYoKSB7XG4gIHJldHVybiBjcWwudHlwZXM7XG59O1xuXG5CYXNlTW9kZWwucHJvdG90eXBlLl9nZXRfZGVmYXVsdF92YWx1ZSA9IGZ1bmN0aW9uIGYoZmllbGRuYW1lKSB7XG4gIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLmNvbnN0cnVjdG9yLl9wcm9wZXJ0aWVzO1xuICBjb25zdCBzY2hlbWEgPSBwcm9wZXJ0aWVzLnNjaGVtYTtcblxuICBpZiAoXy5pc1BsYWluT2JqZWN0KHNjaGVtYS5maWVsZHNbZmllbGRuYW1lXSkgJiYgc2NoZW1hLmZpZWxkc1tmaWVsZG5hbWVdLmRlZmF1bHQgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICh0eXBlb2Ygc2NoZW1hLmZpZWxkc1tmaWVsZG5hbWVdLmRlZmF1bHQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybiBzY2hlbWEuZmllbGRzW2ZpZWxkbmFtZV0uZGVmYXVsdC5jYWxsKHRoaXMpO1xuICAgIH1cbiAgICByZXR1cm4gc2NoZW1hLmZpZWxkc1tmaWVsZG5hbWVdLmRlZmF1bHQ7XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn07XG5cbkJhc2VNb2RlbC5wcm90b3R5cGUudmFsaWRhdGUgPSBmdW5jdGlvbiBmKHByb3BlcnR5TmFtZSwgdmFsdWUpIHtcbiAgdmFsdWUgPSB2YWx1ZSB8fCB0aGlzW3Byb3BlcnR5TmFtZV07XG4gIHRoaXMuX3ZhbGlkYXRvcnMgPSB0aGlzLl92YWxpZGF0b3JzIHx8IHt9O1xuICByZXR1cm4gdGhpcy5jb25zdHJ1Y3Rvci5fdmFsaWRhdGUodGhpcy5fdmFsaWRhdG9yc1twcm9wZXJ0eU5hbWVdIHx8IFtdLCB2YWx1ZSk7XG59O1xuXG5CYXNlTW9kZWwucHJvdG90eXBlLnNhdmUgPSBmdW5jdGlvbiBmbihvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMSAmJiB0eXBlb2Ygb3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0ge307XG4gIH1cblxuICBjb25zdCBpZGVudGlmaWVycyA9IFtdO1xuICBjb25zdCB2YWx1ZXMgPSBbXTtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuY29uc3RydWN0b3IuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IHNjaGVtYSA9IHByb3BlcnRpZXMuc2NoZW1hO1xuXG4gIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgIHByZXBhcmU6IHRydWUsXG4gIH07XG5cbiAgb3B0aW9ucyA9IF8uZGVmYXVsdHNEZWVwKG9wdGlvbnMsIGRlZmF1bHRzKTtcblxuICBjb25zdCBxdWVyeVBhcmFtcyA9IFtdO1xuXG4gIGNvbnN0IGVycm9ySGFwcGVuZWQgPSBPYmplY3Qua2V5cyhzY2hlbWEuZmllbGRzKS5zb21lKChmKSA9PiB7XG4gICAgaWYgKHNjaGVtYS5maWVsZHNbZl0udmlydHVhbCkgcmV0dXJuIGZhbHNlO1xuXG4gICAgLy8gY2hlY2sgZmllbGQgdmFsdWVcbiAgICBjb25zdCBmaWVsZHR5cGUgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHNjaGVtYSwgZik7XG4gICAgbGV0IGZpZWxkdmFsdWUgPSB0aGlzW2ZdO1xuXG4gICAgaWYgKGZpZWxkdmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZmllbGR2YWx1ZSA9IHRoaXMuX2dldF9kZWZhdWx0X3ZhbHVlKGYpO1xuICAgICAgaWYgKGZpZWxkdmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpZiAoc2NoZW1hLmtleS5pbmRleE9mKGYpID49IDAgfHwgc2NoZW1hLmtleVswXS5pbmRleE9mKGYpID49IDApIHtcbiAgICAgICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5zYXZlLnVuc2V0a2V5JywgZikpO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5zYXZlLnVuc2V0a2V5JywgZikpO1xuICAgICAgICB9IGVsc2UgaWYgKHNjaGVtYS5maWVsZHNbZl0ucnVsZSAmJiBzY2hlbWEuZmllbGRzW2ZdLnJ1bGUucmVxdWlyZWQpIHtcbiAgICAgICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5zYXZlLnVuc2V0cmVxdWlyZWQnLCBmKSk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUudW5zZXRyZXF1aXJlZCcsIGYpKTtcbiAgICAgICAgfSBlbHNlIHJldHVybiBmYWxzZTtcbiAgICAgIH0gZWxzZSBpZiAoIXNjaGVtYS5maWVsZHNbZl0ucnVsZSB8fCAhc2NoZW1hLmZpZWxkc1tmXS5ydWxlLmlnbm9yZV9kZWZhdWx0KSB7XG4gICAgICAgIC8vIGRpZCBzZXQgYSBkZWZhdWx0IHZhbHVlLCBpZ25vcmUgZGVmYXVsdCBpcyBub3Qgc2V0XG4gICAgICAgIGlmICh0aGlzLnZhbGlkYXRlKGYsIGZpZWxkdmFsdWUpICE9PSB0cnVlKSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuc2F2ZS5pbnZhbGlkZGVmYXVsdHZhbHVlJywgZmllbGR2YWx1ZSwgZiwgZmllbGR0eXBlKSk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuaW52YWxpZGRlZmF1bHR2YWx1ZScsIGZpZWxkdmFsdWUsIGYsIGZpZWxkdHlwZSkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkdmFsdWUgPT09IG51bGwgfHwgZmllbGR2YWx1ZSA9PT0gY3FsLnR5cGVzLnVuc2V0KSB7XG4gICAgICBpZiAoc2NoZW1hLmtleS5pbmRleE9mKGYpID49IDAgfHwgc2NoZW1hLmtleVswXS5pbmRleE9mKGYpID49IDApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUudW5zZXRrZXknLCBmKSk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUudW5zZXRrZXknLCBmKSk7XG4gICAgICB9IGVsc2UgaWYgKHNjaGVtYS5maWVsZHNbZl0ucnVsZSAmJiBzY2hlbWEuZmllbGRzW2ZdLnJ1bGUucmVxdWlyZWQpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUudW5zZXRyZXF1aXJlZCcsIGYpKTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuc2F2ZS51bnNldHJlcXVpcmVkJywgZikpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlkZW50aWZpZXJzLnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIicsIGYpKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBkYlZhbCA9IHRoaXMuY29uc3RydWN0b3IuX2dldF9kYl92YWx1ZV9leHByZXNzaW9uKGYsIGZpZWxkdmFsdWUpO1xuICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkYlZhbCkgJiYgZGJWYWwucXVlcnlfc2VnbWVudCkge1xuICAgICAgICB2YWx1ZXMucHVzaChkYlZhbC5xdWVyeV9zZWdtZW50KTtcbiAgICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFsdWVzLnB1c2goZGJWYWwpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgY2FsbGJhY2soZSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgICAgdGhyb3cgKGUpO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH0pO1xuXG4gIGlmIChlcnJvckhhcHBlbmVkKSByZXR1cm4ge307XG5cbiAgbGV0IHF1ZXJ5ID0gdXRpbC5mb3JtYXQoXG4gICAgJ0lOU0VSVCBJTlRPIFwiJXNcIiAoICVzICkgVkFMVUVTICggJXMgKScsXG4gICAgcHJvcGVydGllcy50YWJsZV9uYW1lLFxuICAgIGlkZW50aWZpZXJzLmpvaW4oJyAsICcpLFxuICAgIHZhbHVlcy5qb2luKCcgLCAnKSxcbiAgKTtcblxuICBpZiAob3B0aW9ucy5pZl9ub3RfZXhpc3QpIHF1ZXJ5ICs9ICcgSUYgTk9UIEVYSVNUUyc7XG4gIGlmIChvcHRpb25zLnR0bCkgcXVlcnkgKz0gdXRpbC5mb3JtYXQoJyBVU0lORyBUVEwgJXMnLCBvcHRpb25zLnR0bCk7XG5cbiAgcXVlcnkgKz0gJzsnO1xuXG4gIC8vIHNldCBkdW1teSBob29rIGZ1bmN0aW9uIGlmIG5vdCBwcmVzZW50IGluIHNjaGVtYVxuICBpZiAodHlwZW9mIHNjaGVtYS5iZWZvcmVfc2F2ZSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHNjaGVtYS5iZWZvcmVfc2F2ZSA9IGZ1bmN0aW9uIGYoaW5zdGFuY2UsIG9wdGlvbiwgbmV4dCkge1xuICAgICAgbmV4dCgpO1xuICAgIH07XG4gIH1cblxuICBpZiAodHlwZW9mIHNjaGVtYS5hZnRlcl9zYXZlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgc2NoZW1hLmFmdGVyX3NhdmUgPSBmdW5jdGlvbiBmKGluc3RhbmNlLCBvcHRpb24sIG5leHQpIHtcbiAgICAgIG5leHQoKTtcbiAgICB9O1xuICB9XG5cbiAgaWYgKG9wdGlvbnMucmV0dXJuX3F1ZXJ5KSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHF1ZXJ5LFxuICAgICAgcGFyYW1zOiBxdWVyeVBhcmFtcyxcbiAgICAgIGJlZm9yZV9ob29rOiAoaG9va0NhbGxiYWNrKSA9PiB7XG4gICAgICAgIHNjaGVtYS5iZWZvcmVfc2F2ZSh0aGlzLCBvcHRpb25zLCAoZXJyb3IpID0+IHtcbiAgICAgICAgICBpZiAoZXJyb3IpIHtcbiAgICAgICAgICAgIGhvb2tDYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5zYXZlLmJlZm9yZS5lcnJvcicsIGVycm9yKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIGhvb2tDYWxsYmFjaygpO1xuICAgICAgICB9KTtcbiAgICAgIH0sXG4gICAgICBhZnRlcl9ob29rOiAoaG9va0NhbGxiYWNrKSA9PiB7XG4gICAgICAgIHNjaGVtYS5hZnRlcl9zYXZlKHRoaXMsIG9wdGlvbnMsIChlcnJvcikgPT4ge1xuICAgICAgICAgIGlmIChlcnJvcikge1xuICAgICAgICAgICAgaG9va0NhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuYWZ0ZXIuZXJyb3InLCBlcnJvcikpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBob29rQ2FsbGJhY2soKTtcbiAgICAgICAgfSk7XG4gICAgICB9LFxuICAgIH07XG4gIH1cblxuICBjb25zdCBxdWVyeU9wdGlvbnMgPSB7IHByZXBhcmU6IG9wdGlvbnMucHJlcGFyZSB9O1xuICBpZiAob3B0aW9ucy5jb25zaXN0ZW5jeSkgcXVlcnlPcHRpb25zLmNvbnNpc3RlbmN5ID0gb3B0aW9ucy5jb25zaXN0ZW5jeTtcbiAgaWYgKG9wdGlvbnMuZmV0Y2hTaXplKSBxdWVyeU9wdGlvbnMuZmV0Y2hTaXplID0gb3B0aW9ucy5mZXRjaFNpemU7XG4gIGlmIChvcHRpb25zLmF1dG9QYWdlKSBxdWVyeU9wdGlvbnMuYXV0b1BhZ2UgPSBvcHRpb25zLmF1dG9QYWdlO1xuICBpZiAob3B0aW9ucy5oaW50cykgcXVlcnlPcHRpb25zLmhpbnRzID0gb3B0aW9ucy5oaW50cztcbiAgaWYgKG9wdGlvbnMucGFnZVN0YXRlKSBxdWVyeU9wdGlvbnMucGFnZVN0YXRlID0gb3B0aW9ucy5wYWdlU3RhdGU7XG4gIGlmIChvcHRpb25zLnJldHJ5KSBxdWVyeU9wdGlvbnMucmV0cnkgPSBvcHRpb25zLnJldHJ5O1xuICBpZiAob3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeSkgcXVlcnlPcHRpb25zLnNlcmlhbENvbnNpc3RlbmN5ID0gb3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeTtcblxuICBzY2hlbWEuYmVmb3JlX3NhdmUodGhpcywgb3B0aW9ucywgKGVycm9yKSA9PiB7XG4gICAgaWYgKGVycm9yKSB7XG4gICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuYmVmb3JlLmVycm9yJywgZXJyb3IpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuYmVmb3JlLmVycm9yJywgZXJyb3IpKTtcbiAgICB9XG5cbiAgICB0aGlzLmNvbnN0cnVjdG9yLl9leGVjdXRlX3RhYmxlX3F1ZXJ5KHF1ZXJ5LCBxdWVyeVBhcmFtcywgcXVlcnlPcHRpb25zLCAoZXJyLCByZXN1bHQpID0+IHtcbiAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuZGJlcnJvcicsIGVycikpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIW9wdGlvbnMuaWZfbm90X2V4aXN0IHx8IChyZXN1bHQucm93cyAmJiByZXN1bHQucm93c1swXSAmJiByZXN1bHQucm93c1swXVsnW2FwcGxpZWRdJ10pKSB7XG4gICAgICAgICAgdGhpcy5fbW9kaWZpZWQgPSB7fTtcbiAgICAgICAgfVxuICAgICAgICBzY2hlbWEuYWZ0ZXJfc2F2ZSh0aGlzLCBvcHRpb25zLCAoZXJyb3IxKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yMSkge1xuICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuc2F2ZS5hZnRlci5lcnJvcicsIGVycm9yMSkpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjYWxsYmFjayhudWxsLCByZXN1bHQpO1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSBpZiAoZXJyKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5zYXZlLmRiZXJyb3InLCBlcnIpKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHNjaGVtYS5hZnRlcl9zYXZlKHRoaXMsIG9wdGlvbnMsIChlcnJvcjEpID0+IHtcbiAgICAgICAgICBpZiAoZXJyb3IxKSB7XG4gICAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuc2F2ZS5hZnRlci5lcnJvcicsIGVycm9yMSkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xuXG4gIHJldHVybiB7fTtcbn07XG5cbkJhc2VNb2RlbC5wcm90b3R5cGUuZGVsZXRlID0gZnVuY3Rpb24gZihvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMSAmJiB0eXBlb2Ygb3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0ge307XG4gIH1cblxuICBjb25zdCBzY2hlbWEgPSB0aGlzLmNvbnN0cnVjdG9yLl9wcm9wZXJ0aWVzLnNjaGVtYTtcbiAgY29uc3QgZGVsZXRlUXVlcnkgPSB7fTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IHNjaGVtYS5rZXkubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBmaWVsZEtleSA9IHNjaGVtYS5rZXlbaV07XG4gICAgaWYgKGZpZWxkS2V5IGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICAgIGZvciAobGV0IGogPSAwOyBqIDwgZmllbGRLZXkubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgZGVsZXRlUXVlcnlbZmllbGRLZXlbal1dID0gdGhpc1tmaWVsZEtleVtqXV07XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGRlbGV0ZVF1ZXJ5W2ZpZWxkS2V5XSA9IHRoaXNbZmllbGRLZXldO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB0aGlzLmNvbnN0cnVjdG9yLmRlbGV0ZShkZWxldGVRdWVyeSwgb3B0aW9ucywgY2FsbGJhY2spO1xufTtcblxuQmFzZU1vZGVsLnByb3RvdHlwZS50b0pTT04gPSBmdW5jdGlvbiB0b0pTT04oKSB7XG4gIGNvbnN0IG9iamVjdCA9IHt9O1xuICBjb25zdCBzY2hlbWEgPSB0aGlzLmNvbnN0cnVjdG9yLl9wcm9wZXJ0aWVzLnNjaGVtYTtcblxuICBPYmplY3Qua2V5cyhzY2hlbWEuZmllbGRzKS5mb3JFYWNoKChmaWVsZCkgPT4ge1xuICAgIG9iamVjdFtmaWVsZF0gPSB0aGlzW2ZpZWxkXTtcbiAgfSk7XG5cbiAgcmV0dXJuIG9iamVjdDtcbn07XG5cbkJhc2VNb2RlbC5wcm90b3R5cGUuaXNNb2RpZmllZCA9IGZ1bmN0aW9uIGlzTW9kaWZpZWQocHJvcE5hbWUpIHtcbiAgaWYgKHByb3BOYW1lKSB7XG4gICAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbCh0aGlzLl9tb2RpZmllZCwgcHJvcE5hbWUpO1xuICB9XG4gIHJldHVybiBPYmplY3Qua2V5cyh0aGlzLl9tb2RpZmllZCkubGVuZ3RoICE9PSAwO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBCYXNlTW9kZWw7XG4iXX0=
