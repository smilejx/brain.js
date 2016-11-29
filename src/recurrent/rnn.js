import Matrix from './matrix';
import sampleI from './matrix/sample-i';
import maxI from './matrix/max-i';
import RandomMatrix from './matrix/random-matrix';
import softmax from './matrix/softmax';
import Equation from './matrix/equation';
import copy from './matrix/copy';

const defaults = {
  isBackPropagate: true,
  // hidden size should be a list
  inputSize: 20,
  inputRange: 20,
  hiddenSizes:[20,20],
  outputSize: 20,
  learningRate: 0.01,
  decayRate: 0.999,
  smoothEps: 1e-8,
  regc: 0.000001,
  clipval: 5,
  json: null
};

export default class RNN {
  constructor(options) {
    options = options || {};

    for (let p in defaults) {
      if (defaults.hasOwnProperty(p) && p !== 'isBackPropagate') {
        this[p] = options.hasOwnProperty(p) ? options[p] : defaults[p];
      }
    }

    this.stepCache = {};
    this.runs = 0;
    this.totalPerplexity = null;
    this.totalCost = null;
    this.ratioClipped = null;

    this.model = {
      input: null,
      hiddenLayers: [],
      output: null,
      equations: [],
      allMatrices: [],
      outputMatrixIndex: -1,
      equationConnections: []
    };

    if (this.json) {
      this.fromJSON(this.json);
    } else {
      this.mapModel();
    }
  }

  createHiddenLayers() {
    let hiddenSizes = this.hiddenSizes;
    let model = this.model;
    let hiddenLayers = model.hiddenLayers;
    //0 is end, so add 1 to offset
    hiddenLayers.push(this.getModel(hiddenSizes[0], this.inputSize));
    let prevSize = hiddenSizes[0];

    for (let d = 1; d < hiddenSizes.length; d++) { // loop over depths
      let hiddenSize = hiddenSizes[d];
      hiddenLayers.push(this.getModel(hiddenSize, prevSize));
      prevSize = hiddenSize;
    }
  }

  getModel(hiddenSize, prevSize) {
    return {
      //wxh
      weight: new RandomMatrix(hiddenSize, prevSize, 0.08),
      //whh
      transition: new RandomMatrix(hiddenSize, hiddenSize, 0.08),
      //bhh
      bias: new Matrix(hiddenSize, 1)
    };
  }

  /**
   *
   * @param {Equation} equation
   * @param {Matrix} inputMatrix
   * @param {Matrix} previousResult
   * @param {Object} hiddenLayer
   * @returns {Matrix}
   */
  getEquation(equation, inputMatrix, previousResult, hiddenLayer) {
    let relu = equation.relu.bind(equation);
    let add = equation.add.bind(equation);
    let multiply = equation.multiply.bind(equation);

    return relu(
      add(
        add(
          multiply(
            hiddenLayer.weight,
            inputMatrix
          ),
          multiply(
            hiddenLayer.transition,
            previousResult
          )
        ),
        hiddenLayer.bias
      )
    );
  }

  createInputMatrix() {
    //0 is end, so add 1 to offset
    this.model.input = new RandomMatrix(this.inputRange + 1, this.inputSize, 0.08);
  }

  createOutputMatrix() {
    let model = this.model;
    let outputSize = this.outputSize;
    let lastHiddenSize = this.hiddenSizes[this.hiddenSizes.length - 1];

    //0 is end, so add 1 to offset
    //whd
    model.outputConnector = new RandomMatrix(outputSize + 1, lastHiddenSize, 0.08);
    //0 is end, so add 1 to offset
    //bd
    model.output = new Matrix(outputSize + 1, 1);
  }

  bindEquation() {
    let model = this.model;
    let hiddenSizes = this.hiddenSizes;
    let hiddenLayers = model.hiddenLayers;
    let equation = new Equation();
    let outputs = [];
    let equationConnection = model.equationConnections.length > 0
      ? model.equationConnections[model.equationConnections.length - 1]
      : hiddenSizes.map((size) => new Matrix(hiddenSizes[0], 1))
      ;

      // 0 index
    let output = this.getEquation(equation, equation.inputMatrixToRow(model.input), equationConnection[0], hiddenLayers[0]);
    outputs.push(output);
    // 1+ indexes
    for (let i = 1, max = hiddenSizes.length; i < max; i++) {
      output = this.getEquation(equation, output, equationConnection[i], hiddenLayers[i]);
      outputs.push(output);
    }

    model.equationConnections.push(outputs);
    equation.add(equation.multiply(model.outputConnector, output), model.output);
    model.allMatrices = model.allMatrices.concat(equation.allMatrices);
    model.equations.push(equation);
  }

  mapModel() {
    let model = this.model;
    let hiddenLayers = model.hiddenLayers;
    let allMatrices = model.allMatrices;

    this.createInputMatrix();
    if (!model.input) throw new Error('net.model.input not set');
    allMatrices.push(model.input);

    this.createHiddenLayers();
    if (!model.hiddenLayers.length) throw new Error('net.hiddenLayers not set');
    for (let i = 0, max = hiddenLayers.length; i < max; i++) {
      let hiddenMatrix = hiddenLayers[i];
      for (let property in hiddenMatrix) {
        if (!hiddenMatrix.hasOwnProperty(property)) continue;
        allMatrices.push(hiddenMatrix[property]);
      }
    }

    this.createOutputMatrix();
    if (!model.outputConnector) throw new Error('net.model.outputConnector not set');
    if (!model.output) throw new Error('net.model.output not set');

    allMatrices.push(model.outputConnector);
    model.outputMatrixIndex = allMatrices.length;
    allMatrices.push(model.output);
  }

  run(input) {
    this.train(input);
    this.runBackpropagate(input);
    this.step();
  }

  runPredict() {
    let prediction = this.predict();
    this.runBackpropagate(prediction);
    this.step();
    return prediction;
  }

  train(input) {
    this.runs++;
    let model = this.model;
    let max = input.length;
    let log2ppl = 0;
    let cost = 0;

    let i;
    let equation;
    while (model.equations.length <= input.length + 1) {//first and last are zeros
      this.bindEquation();
    }
    for (i = -1; i < max; i++) {
      // start and end tokens are zeros
      equation = model.equations[i + 1];

      let source = (i === -1 ? 0 : input[i] + 1); // first step: start with START token
      let target = (i === max - 1 ? 0 : input[i + 1] + 1); // last step: end with END token
      let output = equation.run(source);
      // set gradients into log probabilities
      let logProbabilities = output; // interpret output as log probabilities
      let probabilities = softmax(output); // compute the softmax probabilities

      log2ppl += -Math.log2(probabilities.weights[target]); // accumulate base 2 log prob and do smoothing
      cost += -Math.log(probabilities.weights[target]);

      // write gradients into log probabilities
      logProbabilities.recurrence = probabilities.weights;
      logProbabilities.recurrence[target] -= 1;
    }

    this.totalPerplexity = Math.pow(2, log2ppl / (max - 1));
    this.totalCost = cost;
  }

  runBackpropagate(input) {
    var i = input.length + 0;
    var model = this.model;
    var equations = model.equations;
    while(i > 0) {
      equations[i].runBackpropagate(input[i - 1] + 1);
      i--;
    }
    equations[0].runBackpropagate(0);
  }

  step() {
    // perform parameter update
    let stepSize = this.learningRate;
    let regc = this.regc;
    let clipval = this.clipval;
    let model = this.model;
    let numClipped = 0;
    let numTot = 0;
    let allMatrices = model.allMatrices;
    let matrixIndexes = allMatrices.length;
    for (let matrixIndex = 0; matrixIndex < matrixIndexes; matrixIndex++) {
      let matrix = allMatrices[matrixIndex];
      if (!(matrixIndex in this.stepCache)) {
        this.stepCache[matrixIndex] = new Matrix(matrix.rows, matrix.columns);
      }
      let cache = this.stepCache[matrixIndex];

      //if we are in an equation, reset the weights and recurrence to 0, to prevent exploding gradient problem
      if (matrixIndex > model.outputMatrixIndex) {
        for (let i = 0, n = matrix.weights.length; i < n; i++) {
          matrix.weights[i] = 0;
          matrix.recurrence[i] = 0;
        }
        continue;
      }

      for (let i = 0, n = matrix.weights.length; i < n; i++) {
        // rmsprop adaptive learning rate
        let mdwi = matrix.recurrence[i];
        cache.weights[i] = cache.weights[i] * this.decayRate + (1 - this.decayRate) * mdwi * mdwi;
        // gradient clip
        if (mdwi > clipval) {
          mdwi = clipval;
          numClipped++;
        }
        if (mdwi < -clipval) {
          mdwi = -clipval;
          numClipped++;
        }
        numTot++;

        // update (and regularize)
        matrix.weights[i] = matrix.weights[i] + -stepSize * mdwi / Math.sqrt(cache.weights[i] + this.smoothEps) - regc * matrix.weights[i];
        matrix.recurrence[i] = 0; // reset gradients for next iteration
      }
    }
    this.ratioClipped = numClipped / numTot;
  }

  predict(maxPredictionLength = 100, _sampleI = false, temperature = 1) {
    let model = this.model;
    let result = [];
    let equation;
    let i = 0;
    while (model.equations.length < maxPredictionLength) {
      this.bindEquation();
    }
    while (true) {
      let ix = result.length === 0 ? 0 : result[result.length - 1];
      equation = model.equations[i];
      // sample predicted letter
      let output = equation.run(ix);

      let logProbabilities = new Matrix(model.output.rows, model.output.columns);
      copy(logProbabilities, output);
      if (temperature !== 1 && _sampleI) {
        // scale log probabilities by temperature and renormalize
        // if temperature is high, logprobs will go towards zero
        // and the softmax outputs will be more diffuse. if temperature is
        // very low, the softmax outputs will be more peaky
        for (let q = 0, nq = logProbabilities.weights.length; q < nq; q++) {
          logProbabilities.weights[q] /= temperature;
        }
      }

      let probs = softmax(logProbabilities);

      if (_sampleI) {
        ix = sampleI(probs);
      } else {
        ix = maxI(probs);
      }

      i++;
      if (ix === 0) {
        // END token predicted, break out
        break;
      }
      if (i >= maxPredictionLength) {
        // something is wrong
        break;
      }

      result.push(ix);
    }

    return result.map((value) => value - 1);
  }

  /**
   *
   * @param input
   * @returns {*}
   */
  runInput(input) {
    this.outputs[0] = input;  // set output state of input layer

    let output = null;
    for (let layer = 1; layer <= this.outputLayer; layer++) {
      for (let node = 0; node < this.sizes[layer]; node++) {
        let weights = this.weights[layer][node];

        let sum = this.biases[layer][node];
        for (let k = 0; k < weights.length; k++) {
          sum += weights[k] * input[k];
        }
        this.outputs[layer][node] = 1 / (1 + Math.exp(-sum));
      }
      output = input = this.outputs[layer];
    }
    return output;
  }

  /**
   *
   * @param data
   * @param options
   * @returns {{error: number, iterations: number}}
   */
  /*train(data, options) {
    throw new Error('not yet implemented');
    //data = this.formatData(data);

    options = options || {};
    let iterations = options.iterations || 20000;
    let errorThresh = options.errorThresh || 0.005;
    let log = options.log ? (typeof options.log === 'function' ? options.log : console.log) : false;
    let logPeriod = options.logPeriod || 10;
    let learningRate = options.learningRate || this.learningRate || 0.3;
    let callback = options.callback;
    let callbackPeriod = options.callbackPeriod || 10;
    let sizes = [];
    let inputSize = data[0].input.length;
    let outputSize = data[0].output.length;
    let hiddenSizes = this.hiddenSizes;
    if (!hiddenSizes) {
      sizes.push(Math.max(3, Math.floor(inputSize / 2)));
    } else {
      hiddenSizes.forEach(function(size) {
        sizes.push(size);
      });
    }

    sizes.unshift(inputSize);
    sizes.push(outputSize);

    //this.initialize(sizes, options.keepNetworkIntact);

    let error = 1;
    for (let i = 0; i < iterations && error > errorThresh; i++) {
      let sum = 0;
      for (let j = 0; j < data.length; j++) {
        let err = this.trainPattern(data[j].input, data[j].output, learningRate);
        sum += err;
      }
      error = sum / data.length;

      if (log && (i % logPeriod == 0)) {
        log('iterations:', i, 'training error:', error);
      }
      if (callback && (i % callbackPeriod == 0)) {
        callback({ error: error, iterations: i });
      }
    }

    return {
      error: error,
      iterations: i
    };
  }*/

  /**
   *
   * @param input
   * @param target
   * @param learningRate
   */
  trainPattern(input, target, learningRate) {
    throw new Error('not yet implemented');
  }

  /**
   *
   * @param target
   */
  calculateDeltas(target) {
    throw new Error('not yet implemented');
  }

  /**
   *
   * @param learningRate
   */
  adjustWeights(learningRate) {
    throw new Error('not yet implemented');
  }

  /**
   *
   * @param data
   * @returns {*}
   */
  formatData(data) {
    throw new Error('not yet implemented');
  }

  /**
   *
   * @param data
   * @returns {
   *  {
   *    error: number,
   *    misclasses: Array
   *  }
   * }
   */
  test(data) {
    throw new Error('not yet implemented');
  }

  toJSON() {
    let model = this.model;
    let options = {};
    for (let p in defaults) {
      options[p] = this[p];
    }

    return {
      type: this.constructor.name,
      options: options,
      input: model.input.toJSON(),
      hiddenLayers: model.hiddenLayers.map(function(hiddenLayer) {
        let layers = {};
        for (let p in hiddenLayer) {
          layers[p] = hiddenLayer[p].toJSON();
        }
        return layers;
      }),
      outputConnector: this.model.outputConnector.toJSON(),
      output: this.model.output.toJSON()
    };
  }

  fromJSON(json) {
    this.json = json;
    let model = this.model;
    let options = json.options;
    let allMatrices = model.allMatrices;
    model.input = Matrix.fromJSON(json.input);
    allMatrices.push(model.input);
    model.hiddenLayers = json.hiddenLayers.map(function(hiddenLayer) {
      let layers = {};
      for (let p in hiddenLayer) {
        layers[p] = Matrix.fromJSON(hiddenLayer[p]);
        allMatrices.push(layers[p]);
      }
      return layers;
    });
    model.outputConnector = Matrix.fromJSON(json.outputConnector);
    model.output = Matrix.fromJSON(json.output);
    allMatrices.push(model.outputConnector, model.output);

    for (let p in defaults) {
      if (defaults.hasOwnProperty(p) && p !== 'isBackPropagate') {
        this[p] = options.hasOwnProperty(p) ? options[p] : defaults[p];
      }
    }

    this.bindEquation();
  }

  /**
   *
   * @returns {Function}
   */
  toFunction() {
    let model = this.model;
    let equation = this.model.equations[0];
    let states = equation.states;
    let modelAsString = JSON.stringify(this.toJSON());

    function matrixOrigin(m, requestedStateIndex) {
      for (let i = 0, max = states.length; i < max; i++) {
        let state = states[i];

        if (i === requestedStateIndex) {
          switch (m) {
            case state.product:
            case state.left:
            case state.right:
              return `new Matrix(${ m.rows }, ${ m.columns })`;
          }
        }

        if (m === state.product) return `states[${ i }].product`;
        if (m === state.right) return `states[${ i }].right`;
        if (m === state.left) return `states[${ i }].left`;
      }
    }

    function matrixToString(m, stateIndex) {
      if (!m) return 'null';

      for (let i = 0, max = model.hiddenLayers.length; i < max; i++) {
        let hiddenLayer = model.hiddenLayers[i];
        for (let p in hiddenLayer) {
          if (hiddenLayer[p] === m) {
            return `model.hiddenLayers[${ i }].${ p }`;
          }
        }
      }
      if (m === model.input) return `model.input`;
      if (m === model.outputConnector) return `model.outputConnector`;
      if (m === model.output) return `model.output`;
      return matrixOrigin(m, stateIndex);
    }

    function toInner(fnString) {
      //crude, but should be sufficient for now
      //function() { inner.function.string.here; }
      fnString = fnString.toString().split('{');
      fnString.shift();
      // inner.function.string.here; }
      fnString = fnString.join('{');
      fnString = fnString.split('}');
      fnString.pop();
      // inner.function.string.here;
      return fnString.join('}');
    }

    function fileName(fnName) {
      return `src/recurrent/matrix/${ fnName.replace(/[A-Z]/g, function(value) { return '-' + value.toLowerCase(); }) }.js`;
    }

    let statesRaw = [];
    let usedFunctionNames = {};
    let innerFunctionsSwitch = [];
    for (let i = 0, max = states.length; i < max; i++) {
      let state = states[i];
      statesRaw.push(`states[${ i }] = {
        name: '${ state.forwardFn.name }',
        left: ${ matrixToString(state.left, i) },
        right: ${ matrixToString(state.right, i) },
        product: ${ matrixToString(state.product, i) }
      };`);

      let fnName = state.forwardFn.name;
      if (!usedFunctionNames[fnName]) {
        usedFunctionNames[fnName] = true;
        innerFunctionsSwitch.push(`
        case '${ fnName }': //compiled from ${ fileName(fnName) }
          ${ toInner(state.forwardFn.toString()) }
          break;
        `);
      }
    }

    return new Function('input', `
      var model = ${ modelAsString };
      
      function Matrix(rows, columns) {
        this.rows = rows;
        this.columns = columns;
        this.weights = zeros(rows * columns);
        this.recurrence = zeros(rows * columns);
      }
      
      function zeros(size) {
        if (typeof Float64Array !== 'undefined') return new Float64Array(size);
        var array = new Array(size);
        for (var i = 0; i < size; i++) {
          array[i] = 0;
        }
        return array;
      }
      
      for (var inputIndex = 0, inputMax = input.length; inputIndex < inputMax; inputIndex++) {
        var ixSource = (inputIndex === -1 ? 0 : input[inputIndex]); // first step: start with START token
        var ixTarget = (inputIndex === inputMax - 1 ? 0 : input[inputIndex + 1]); // last step: end with END token
        var rowPluckIndex = inputIndex; //connect up to rowPluck
        var states = {};
        ${ statesRaw.join('\n') }
        for (var stateIndex = 0, stateMax = ${ statesRaw.length }; stateIndex < stateMax; stateIndex++) {
          var state = states[stateIndex];
          var product = state.product;
          var left = state.left;
          var right = state.right;
          
          switch (state.name) {
            ${ innerFunctionsSwitch.join('\n') }
          }
        }
      }
      
      return state.product;
    `);
  }
}