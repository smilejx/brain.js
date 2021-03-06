import Base from './base';

class Regression extends Base {
  constructor(settings) {
    super(settings);
    this.validate();
  }
  predict() {
    this.weights = this.inputs;
  }

  learn() {

  }
}

function learn(inputs, targets) {
  return inputs[this.thread.x] - targets[this.thread.x];
}

//TODO: handle `loss += 0.5*dy*dy;` total and sum in learn