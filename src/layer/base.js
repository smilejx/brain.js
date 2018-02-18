import zeros2D from '../utilities/zeros-2d';

export default class Base {
  static get defaults() {
    return {
      width: 1,
      height: 1,
      weights: null,
      deltas: null,
      name: null
    };
  }

  constructor(settings = {}) {
    //size
    this.width = null;
    this.height = null;

    //what matters :P
    this.errors = null;
    this.deltas = null;
    this.weights = null;

    this.praxis = null;
    if (this.constructor !== Base) {
      Object.assign(this, Base.defaults, settings);
    }
    Object.assign(this, this.constructor.defaults, settings);

    // special settings
    if (settings.hasOwnProperty('praxis')) {
      this.praxis = settings.praxis(this);
    }
  }

  validate() {
    if (isNaN(this.height)) {
      throw new Error(`${this.constructor.name} layer height is not a number`)
    }
    if (isNaN(this.width)) {
      throw new Error(`${this.constructor.name} layer width is not a number`)
    }
    if (this.height < 1) {
      throw new Error(`${this.constructor.name} layer height is less than 1`);
    }
    if (this.width < 1) {
      throw new Error(`${this.constructor.name} layer width is less than 1`);
    }
  }

  setupKernels() {}

  predict() {
    throw new Error('`predict` not defined on Base layer');
  }

  compare(previousLayer, nextLayer) {
    throw new Error('`compare` not defined on Base layer');
  }

  learn(previousLayer, nextLayer, learningRate) {
    this.weights = this.praxis.run(previousLayer, nextLayer, learningRate);
    this.deltas = zeros2D(this.width, this.height);
  }

  toArray() {
    return this.weights.toArray();
  }

  toJSON() {
    const jsonLayer = {};
    const { defaults, name } = this.constructor;
    if (this.constructor !== Base) {
      Object.assign(defaults, Base.defaults, defaults);
    }
    const keys = Object.keys(defaults);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === 'deltas') continue;
      if (key === 'name' && this[key] === null) continue;
      jsonLayer[key] = this[key];
    }
    jsonLayer.type = name;
    return jsonLayer;
  }
}