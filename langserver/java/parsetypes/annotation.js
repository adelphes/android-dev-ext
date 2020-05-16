/**
 * @typedef {import('./token')} Token
 */

 class Annotation {
    /**
     * @param {Token} at 
     * @param {Token} name 
     */
    constructor(at, name) {
        this.at = at;
        this.name = name;
    }
}

module.exports = Annotation;
