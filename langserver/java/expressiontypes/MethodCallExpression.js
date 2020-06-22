/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");
const { AnyType, AnyMethod, LambdaType, MethodType } = require('../anys');
const { ArrayType, JavaType, Method,PrimitiveType, ReifiedConstructor, ReifiedMethod, Constructor } = require('java-mti');
const { NumberLiteral } = require('./literals/Number');
const { InstanceLiteral } = require('./literals/Instance')
const { isTypeAssignable } = require('../expression-resolver');
const ParseProblem = require('../parsetypes/parse-problem');
const { ValidateInfo } = require('../body-types');
const { SourceConstructor } = require('../source-types');

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
            // check if this is an aleternate or super constructor call: this() / super()
            const instance = this.instance.variables[0];
            if (!(instance instanceof InstanceLiteral) || !(type instanceof JavaType)) {
                ri.problems.push(ParseProblem.Error(this.instance.tokens, `Expression is not a named method'`));
                return AnyType.Instance;
            }
            let is_ctr = false;
            if (ri instanceof ValidateInfo) {
                is_ctr = ri.method instanceof SourceConstructor;
            }
            if (is_ctr) {
                resolveConstructorCall(ri, type.constructors, this.args, () => this.instance.tokens);
            } else {
                ri.problems.push(ParseProblem.Error(this.instance.tokens, `'this'/'super' constructor calls can only be used as the first statement of a constructor`));
            }
            return PrimitiveType.map.V;
        }

        return resolveMethodCall(ri, type.methods, this.args, () => this.instance.tokens);
    }

    tokens() {
        return this.instance.tokens;
    }
}

/**
 * @param {ResolveInfo} ri 
 * @param {Method[]} methods 
 * @param {ResolvedIdent[]} args 
 * @param {() => Token[]} tokens 
 */
function resolveMethodCall(ri, methods, args, tokens) {
    const resolved_args = args.map(arg => arg.resolveExpression(ri));

    // all the arguments must be typed expressions, number literals or lambdas
    /** @type {(JavaType|NumberLiteral|LambdaType)[]} */
    const arg_types = [];
    resolved_args.forEach((a, idx) => {
        if (a instanceof JavaType || a instanceof NumberLiteral || a instanceof LambdaType) {
            arg_types.push(a);
            return;
        }
        ri.problems.push(ParseProblem.Error(args[idx].tokens, `Expression expected`))
        // use AnyType for this argument
        arg_types.push(AnyType.Instance);
    });

    // reify any methods with type-variables
    // - lambda expressions can't be used as type arguments so just pass them as void
    const arg_java_types = arg_types.map(a => 
        a instanceof NumberLiteral ? a.type 
        : a instanceof LambdaType ? PrimitiveType.map.V
        : a);
    const reified_methods = methods.map(m => {
            if (m.typeVariables.length) {
                m = ReifiedMethod.build(m, arg_java_types);
            }
            return m;
        });

    // work out which methods are compatible with the call arguments
    const compatible_methods = reified_methods.filter(m => isCallCompatible(m, arg_types));
    const return_types = new Set(compatible_methods.map(m => m.returnType));

    if (!compatible_methods[0]) {
        // if any of the arguments is AnyType, just return AnyType
        if (arg_java_types.find(t => t instanceof AnyType)) {
            return AnyType.Instance;
        }
        const methodlist = reified_methods.map(m => m.label).join('\n-  ');
        const callargtypes = arg_java_types.map(t => t.fullyDottedTypeName).join(' , ');
        ri.problems.push(ParseProblem.Error(tokens(),
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
        ri.problems.push(ParseProblem.Error(tokens(),
            `Ambiguous method call. Matched argument types:\n- ( ${callargtypes} ) with:\n-  ${methodlist}`
        ));
        return return_types.size > 1 ? AnyType.Instance : compatible_methods[0].returnType;
    }

    return compatible_methods[0].returnType;
}


/**
 * @param {ResolveInfo} ri 
 * @param {Constructor[]} constructors 
 * @param {ResolvedIdent[]} args 
 * @param {() => Token[]} tokens 
 */
function resolveConstructorCall(ri, constructors, args, tokens) {
    const resolved_args = args.map(arg => arg.resolveExpression(ri));

    // all the arguments must be typed expressions, number literals or lambdas
    /** @type {(JavaType|NumberLiteral|LambdaType)[]} */
    const arg_types = [];
    resolved_args.forEach((a, idx) => {
        if (a instanceof JavaType || a instanceof NumberLiteral || a instanceof LambdaType) {
            arg_types.push(a);
            return;
        }
        ri.problems.push(ParseProblem.Error(args[idx].tokens, `Expression expected`))
        // use AnyType for this argument
        arg_types.push(AnyType.Instance);
    });

    // reify any methods with type-variables
    // - lambda expressions can't be used as type arguments so just pass them as void
    const arg_java_types = arg_types.map(a => 
        a instanceof NumberLiteral ? a.type 
        : a instanceof LambdaType ? PrimitiveType.map.V
        : a);
    const reifed_ctrs = constructors.map(c => {
            if (c.typeVariables.length) {
                c = ReifiedConstructor.build(c, arg_java_types);
            }
            return c;
        });

    // work out which methods are compatible with the call arguments
    const compatible_ctrs = reifed_ctrs.filter(m => isCallCompatible(m, arg_types));

    if (!compatible_ctrs[0]) {
        // if any of the arguments is AnyType, just ignore the call
        if (arg_java_types.find(t => t instanceof AnyType)) {
            return;
        }
        const ctrlist = reifed_ctrs.map(m => m.label).join('\n-  ');
        const callargtypes = arg_java_types.map(t => t.fullyDottedTypeName).join(' , ');
        ri.problems.push(ParseProblem.Error(tokens(),
            `No compatible constructor found. Tried to match argument types:\n- ( ${callargtypes} ) with:\n-  ${ctrlist}`
        ));
        return;
    }

    if (compatible_ctrs.length > 1) {
        // if any of the arguments is AnyType, return the known return-type or AnyType
        if (arg_java_types.find(t => t instanceof AnyType)) {
            return;
        }
        // see if we have an exact match
        const callsig = `(${arg_java_types.map(t => t.typeSignature).join('')})`;
        const exact_match = compatible_ctrs.find(m => m.methodSignature.startsWith(callsig));
        if (exact_match) {
            compatible_ctrs.splice(0, compatible_ctrs.length, exact_match);
        }
    }

    if (compatible_ctrs.length > 1) {
        const ctrlist = compatible_ctrs.map(m => m.label).join('\n-  ');
        const callargtypes = arg_java_types.map(t => t.fullyDottedTypeName).join(' , ');
        ri.problems.push(ParseProblem.Error(tokens(),
            `Ambiguous constructor call. Matched argument types:\n- ( ${callargtypes} ) with:\n-  ${ctrlist}`
        ));
        return;
    }
}

/**
 * 
 * @param {Method|Constructor} m 
 * @param {(JavaType | NumberLiteral | LambdaType)[]} arg_types 
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
