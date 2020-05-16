/**
 * @typedef {import('./token')} Token
 */

class TypeParameters {
    /**
     * 
     * @param {Token} open 
     * @param {Token} close 
     */
    constructor(open, close) {
        this.open = open;
        this.close = close;
    }
}

module.exports = TypeParameters;
