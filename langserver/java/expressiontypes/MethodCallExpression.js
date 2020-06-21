/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 */
const { Expression } = require("./Expression");
const { AnyType, AnyMethod, MethodType } = require('../anys');
const { ArrayType, JavaType, Method, ReifiedMethod } = require('java-mti');
const { NumberLiteral } = require('./literals/Number');
const { isTypeAssignable } = require('../expression-resolver');
const ParseProblem = require('../parsetypes/parse-problem');

class MethodCallExpression extends Expression {
    /**
     * @param {ResolvedIdent} instance
     * @param {ResolvedIdent[]} args
     */
    constructor(instance, args) {
        super();
        this.instance = instance;
        this.args = args;
    }

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        const type = this.instance.resolveExpression(ri);
        if (type instanceof AnyType) {
            return AnyType.Instance;
        }
        if (!(type instanceof MethodType)) {
            ri.problems.push(ParseProblem.Error(this.instance.tokens, `Expression is not a named method'`));
            return AnyType.Instance;
        }
        const resolved_args = this.args.map(arg => arg.resolveExpression(ri));

        // all the arguments must be typed expressions or number literals
        /** @type {(JavaType|NumberLiteral)[]} */
        const arg_types = [];
        resolved_args.forEach((a, idx) => {
            if (a instanceof JavaType || a instanceof NumberLiteral) {
                arg_types.push(a);
                return;
            }
            ri.problems.push(ParseProblem.Error(this.args[idx].tokens, `Expression expected`))
            // use AnyType for this argument
            arg_types.push(AnyType.Instance);
        });

        // reify any methods with type-variables
        const arg_java_types = arg_types.map(a => a instanceof NumberLiteral ? a.type : a);
        const methods = type.methods.map(m => {
            if (m.typeVariables.length) {
                m = ReifiedMethod.build(m, arg_java_types);
            }
            return m;
        });

        // work out which methods are compatible with the call arguments
        const compatible_methods = methods.filter(m => isCallCompatible(m, arg_types));
        const return_types = new Set(compatible_methods.map(m => m.returnType));

        if (!compatible_methods[0]) {
            // if any of the arguments is AnyType, just return AnyType
            if (arg_java_types.find(t => t instanceof AnyType)) {
                return AnyType.Instance;
            }
            const methodlist = methods.map(m => m.label).join('\n-  ');
            const callargtypes = arg_java_types.map(t => t.fullyDottedTypeName).join(' , ');
            ri.problems.push(ParseProblem.Error(this.instance.tokens,
                `No compatible method found. Tried to match argument types:\n- ( ${callargtypes} ) with:\n-  ${methodlist}`
            ));
            return AnyType.Instance;
        }

        if (compatible_methods.length > 1) {
            // if any of the arguments is AnyType, return the known return-type or AnyType
            if (arg_java_types.find(t => t instanceof AnyType)) {
                return return_types.size > 1 ? AnyType.Instance : compatible_methods[0].returnType;
            }
            // see if we have an exact match
            const callsig = `(${arg_java_types.map(t => t.typeSignature).join('')})`;
            const exact_match = compatible_methods.find(m => m.methodSignature.startsWith(callsig));
            if (exact_match) {
                compatible_methods.splice(0, compatible_methods.length, exact_match);
            }
        }

        if (compatible_methods.length > 1) {
            const methodlist = compatible_methods.map(m => m.label).join('\n-  ');
            const callargtypes = arg_java_types.map(t => t.fullyDottedTypeName).join(' , ');
            ri.problems.push(ParseProblem.Error(this.instance.tokens,
                `Ambiguous method call. Matched argument types:\n- ( ${callargtypes} ) with:\n-  ${methodlist}`
            ));
            return return_types.size > 1 ? AnyType.Instance : compatible_methods[0].returnType;
        }

        return compatible_methods[0].returnType;
    }

    tokens() {
        return this.instance.tokens;
    }
}

/**
 * 
 * @param {Method} m 
 * @param {(JavaType | NumberLiteral)[]} arg_types 
 */
function isCallCompatible(m, arg_types) {
    if (m instanceof AnyMethod) {
        return true;
    }
    const param_count = m.parameterCount;
    if (param_count !== arg_types.length) {
        // for variable arity methods, we must have at least n-1 formal parameters
        if (!m.isVariableArity || arg_types.length < param_count - 1) {
            // wrong parameter count
            return false;
        }
    }
    const formal_params = m.parameters.slice();
    const last_param = formal_params.pop();
    for (let i = 0; i < arg_types.length; i++) {
        const param = formal_params[i] || last_param;
        let param_type = param.type;
        if (param.varargs && param_type instanceof ArrayType) {
            // last varargs parameter
            // - if the argument count matches the parameter count, the final argument can match the array or non-array version
            // e.g void v(int... x) will match with v(), v(1) and v(new int[3]);
            if (arg_types.length === param_count) {
                if (isTypeAssignable(param_type, arg_types[i])) {
                    continue;
                }
            }
            param_type = param_type.elementType;
        }
        // is the argument assignable to the parameter
        if (isTypeAssignable(param_type, arg_types[i])) {
            continue;
        }
        // mismatch parameter type
        return false;
    }
    return true;
}

exports.MethodCallExpression = MethodCallExpression;
