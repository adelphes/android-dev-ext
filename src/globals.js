'use strict'

const path = require('path');

// some commonly used Java types in debugger-compatible format
const JTYPES = {
    byte: {typename:'byte',signature:'B'},
    short: {typename:'short',signature:'S'},
    int: {typename:'int',signature:'I'},
    long: {typename:'long',signature:'J'},
    float: {typename:'float',signature:'F'},
    double: {typename:'double',signature:'D'},
    char: {typename:'char',signature:'C'},
    boolean: {typename:'boolean',signature:'Z'},
    null: {typename:'null',signature:'Lnull;'},   // null has no type really, but we need something for literals
    String: {typename:'String',signature:'Ljava/lang/String;'},
    Object: {typename:'Object',signature:'Ljava/lang/Object;'},
    isArray(t) { return t.signature[0]==='[' },
    isObject(t) { return t.signature[0]==='L' },
    isReference(t) { return /^[L[]/.test(t.signature) },
    isPrimitive(t) { return !JTYPES.isReference(t.signature) },
    isInteger(t) { return /^[BCIJS]$/.test(t.signature) },
    isNumber(t) { return /^[BCIJSFD]$/.test(t.signature) },
    isString(t) { return t.signature === this.String.signature },
    isChar(t) { return t.signature === this.char.signature },
    isBoolean(t) { return t.signature === this.boolean.signature },
    fromPrimSig(sig) { return JTYPES['byte,short,int,long,float,double,char,boolean'.split(',')['BSIJFDCZ'.indexOf(sig)]] },
}

function signatureToFullyQualifiedType(sig) {
    var arr = sig.match(/^\[+/) || '';
    if (arr) {
        arr = '[]'.repeat(arr[0].length);
        sig = sig.slice(0, arr.length/2);
    }
    var m = sig.match(/^((L([^<;]+).)|T([^;]+).|.)/);
    if (!m) return '';
    if (m[3]) {
        return m[3].replace(/[/$]/g,'.') + arr;
    } else if (m[4]) {
        return m[4].replace(/[/$]/g, '.') + arr;
    }
    return JTYPES.fromPrimSig(sig[0]) + arr;
}

// the special name given to exception message fields
const exmsg_var_name = ':msg';  

function createJavaString(dbgr, s, opts) {
    const raw = (opts && opts.israw) ? s : s.slice(1,-1).replace(/\\u[0-9a-fA-F]{4}|\\./,decode_char);
    // return a deferred, which resolves to a local variable named 'literal'
    return dbgr.createstring(raw);
}

function decode_char(c) {
    switch(true) {
        case /^\\[^u]$/.test(c):
            // backslash escape
            var x = {b:'\b',f:'\f',r:'\r',n:'\n',t:'\t',v:'\v','0':String.fromCharCode(0)}[c[1]];
            return x || c[1];
        case /^\\u[0-9a-fA-F]{4}$/.test(c):
            // unicode escape
            return String.fromCharCode(parseInt(c.slice(2),16));
        case c.length===1 : 
            return c;
    }
    throw new Error('Invalid character value');
}

function ensure_path_end_slash(p) {
    return p + (/[\\/]$/.test(p) ? '' : path.sep);
}

function is_subpath_of(fpn, subpath) {
    if (!subpath || !fpn) return false;
    subpath = ensure_path_end_slash(''+subpath);
    return fpn.slice(0,subpath.length) === subpath;
}

function variableRefToThreadId(variablesReference) {
    return (variablesReference / 1e9)|0;
}


Object.assign(exports, {
    JTYPES, exmsg_var_name, ensure_path_end_slash, is_subpath_of, decode_char, variableRefToThreadId, createJavaString, signatureToFullyQualifiedType
});
