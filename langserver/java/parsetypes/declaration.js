const Token = require('./token');
/**
 * @typedef {import('./modifier')} Modifier
 * @typedef {import('./type')} TypeDeclaration
 */

/**
 * Base class for Java declarations.
 */
class Declaration {
    /**
     * @param {TypeDeclaration} owner_type the type this declaration belongs to (if any)
     * @param {Token} docs JavaDocs associated with the declaration
     * @param {Modifier[]} modifiers annotations, modifier keywords and type parameters
     */
    constructor(owner_type, docs, modifiers) {
        this.owner_type = owner_type;
        this.docs = docs;
        this.modifiers = modifiers;
    }

    /**
     * returns the raw JavaDoc string or an empty string if no doc is present
     */
    getDocString() {
        return this.docs ? this.docs.text : '';
    }

    /**
     * Returns the raw access modifier text values
     * @returns {string[]}
     */
    getAccessModifierValues() {
        // @ts-ignore
        return this.modifiers.filter(m => m instanceof Token).map(t => t.text);
    }

    /**
     * Finds the token matching the specified modifier
     * @param {string} name 
     * @returns {Token}
     */
    findModifier(name) {
        // @ts-ignore
        return this.modifiers.find(m => (m instanceof Token) && (m.text === name));
    }
}

module.exports = Declaration;
