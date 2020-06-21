/**
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../body-types').Local} Local
 * @typedef {import('../body-types').Label} Label
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 * @typedef {import('../source-types').SourceType} SourceType
 */
const { Statement } = require("./Statement");
const ParseProblem = require('../parsetypes/parse-problem');
const { checkAssignment } = require('../expression-resolver');

class LocalDeclStatement extends Statement {
    /**
     * @param {Local[]} locals 
     */
    constructor(locals) {
        super();
        this.locals = locals;
    }

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        this.locals.forEach(local => {
            if (local.init) {
                checkAssignment(vi, local.type, local.init);
            }
        });
    }
}

exports.LocalDeclStatement = LocalDeclStatement;
