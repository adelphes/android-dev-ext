const ParseProblem = require('./parsetypes/parse-problem');

const { CEIType } = require('java-mti')
const { SourceMethod, SourceConstructor, SourceInitialiser } = require('./source-types');

const { Block } = require("./statementtypes/Block");
const { Statement } = require("./statementtypes/Statement");
const { LocalDeclStatement } = require("./statementtypes/LocalDeclStatement");

const { ValidateInfo } = require('./body-types');

/**
 * @param {Block} block 
 * @param {SourceMethod | SourceConstructor | SourceInitialiser} method 
 * @param {Map<string,CEIType>} typemap 
 * @param {ParseProblem[]} problems 
 */
function checkStatementBlock(block, method, typemap, problems) {
    block.validate(new ValidateInfo(typemap, problems, method));
}

/**
 * @param {Statement} statement 
 * @param {ValidateInfo} vi 
 */
function checkNonVarDeclStatement(statement, vi) {
    if (statement instanceof LocalDeclStatement) {
        vi.problems.push(ParseProblem.Error(statement.locals[0].decltoken, `Local variables cannot be declared as single conditional statements`));
    };
    statement.validate(vi);
}

exports.checkStatementBlock = checkStatementBlock;
exports.checkNonVarDeclStatement = checkNonVarDeclStatement;
