/**
 * @typedef {import('../source-types').SourceMethodLike} SourceMethodLike
 */

class Statement {

    /**
     * @param {SourceMethodLike} owner 
     */
    constructor(owner) {
        this.owner = owner;
    }

    validate(vi) {}
}

exports.Statement = Statement;
