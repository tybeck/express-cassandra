'use strict';

const _ = require('lodash');

class CassandraEvents {

  constructor() {
    this.acceptableTypes = ['insert', 'update', 'delete', 'truncate'];
    this.listeners = [];
  }

  addListener(type, fn) {
    if (type && typeof fn === 'function') {
      type = type.toLowerCase();
      if (~this.acceptableTypes.indexOf(type)) {
        this.listeners.push({ type, fn });
      }
    }
    return this;
  }

  fire(type, data, params) {
    const lastQueryKey = `last${_.startCase(type || '')}Query`;
    if (type && data && data !== this[lastQueryKey]) {
      this[lastQueryKey] = data;
      type = type.toLowerCase();
      if (~this.acceptableTypes.indexOf(type)) {
        _.forEach(this.listeners, o => {
          if (o.type === type) {
            _.forEach(params, param => {
              if (param === null) {
                param = 'null';
              }
              if (_.isObject(param)) {
                const struct = (param.constructor.name).toLowerCase();
                switch (struct) {
                  case 'uuid':
                    param = param.toString();
                    break;
                }
              }
              let index = data.indexOf('?');
              let s1 = data.substr(0, index);
              let s2 = data.substr(index + 1, data.length);
              data = `${s1}${param}${s2}`;
            });
            return o.fn(data);
          }
        });
      }
    }
    return false;
  }

  getListeners() {
    return this.listeners;
  }

}

module.exports = CassandraEvents;
