/**
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 * @typedef {import('../source-types').SourceMethodLike} SourceMethodLike
 */
const { Statement } = require("./Statement");

/**
 * A statement that begins with a keyword (if, do, while, etc)
 */
class KeywordStatement extends Statement {
    /**
     * @param {SourceMethodLike} owner
     * @param {Token} keyword 
     */
    constructor(owner, keyword) {
        super(owner);
        this.keyword = keyword;
    }
}

exports.KeywordStatement = KeywordStatement;
