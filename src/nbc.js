
// arbitrary precision helper class for 64 bit numbers
const NumberBaseConverter = {
    // Adds two arrays for the given base (10 or 16), returning the result.
    add(x, y, base) {
        var z = [], n = Math.max(x.length, y.length), carry = 0, i = 0;
        while (i < n || carry) {
            var xi = i < x.length ? x[i] : 0;
            var yi = i < y.length ? y[i] : 0;
            var zi = carry + xi + yi;
            z.push(zi % base);
            carry = Math.floor(zi / base);
            i++;
        }
        return z;
    },
    // Returns a*x, where x is an array of decimal digits and a is an ordinary
    // JavaScript number. base is the number base of the array x.
    multiplyByNumber(num, x, base) {
        if (num < 0) return null;
        if (num == 0) return [];
        var result = [], power = x;
        for(;;) {
            if (num & 1) {
                result = this.add(result, power, base);
            }
            num = num >> 1;
            if (num === 0) return result;
            power = this.add(power, power, base);
        }
    },
    twosComplement(str, base) {
        const invdigits = str.split('').map(c => base - 1 - parseInt(c,base)).reverse();
        const negdigits = this.add(invdigits, [1], base).slice(0,str.length);
        return negdigits.reverse().map(d => d.toString(base)).join('');
    },
    convertBase(str, fromBase, toBase) {
        if (fromBase === 10 && /[eE]/.test(str)) {
            // convert exponents to a string of zeros
            var s = str.split(/[eE]/);
            str = s[0] + '0'.repeat(parseInt(s[1],10)); // works for 0/+ve exponent,-ve throws
        }
        var digits = str.split('').map(d => parseInt(d,fromBase)).reverse();
        var outArray = [], power = [1];
        for (var i = 0; i < digits.length; i++) {
            if (digits[i]) {
                outArray = this.add(outArray, this.multiplyByNumber(digits[i], power, toBase), toBase);
            }
            power = this.multiplyByNumber(fromBase, power, toBase);
        }
        return outArray.reverse().map(d => d.toString(toBase)).join('');
    },
    decToHex(decstr, minlen) {
        var res, isneg = decstr[0] === '-';
        if (isneg) decstr = decstr.slice(1)
        decstr = decstr.match(/^0*(.+)$/)[1];   // strip leading zeros
        if (decstr.length < 16 && !/[eE]/.test(decstr)) {  // 16 = Math.pow(2,52).toString(10).length
            // less than 52 bits - just use parseInt
            res = parseInt(decstr, 10).toString(16);
        } else {
            res = NumberBaseConverter.convertBase(decstr, 10, 16);
        }
        if (isneg) {
            res = NumberBaseConverter.twosComplement(res, 16);
            if (/^[0-7]/.test(res)) res = 'f'+res;  //msb must be set for -ve numbers
        } else if (/^[^0-7]/.test(res))
            res = '0' + res;    // msb must not be set for +ve numbers
        if (minlen && res.length < minlen) {
            res = (isneg?'f':'0').repeat(minlen - res.length) + res;
        }
        return res;
    },
    hexToDec(hexstr, signed) {
        var res, isneg = /^[^0-7]/.test(hexstr);
        if (hexstr.match(/^0*(.+)$/)[1].length*4 < 52) {
            // less than 52 bits - just use parseInt
            res = parseInt(hexstr, 16);
            if (signed && isneg) res = -res;
            return res.toString(10);
        }
        if (isneg) {
            hexstr = NumberBaseConverter.twosComplement(hexstr, 16);
        }
        res = (isneg ? '-' : '') + NumberBaseConverter.convertBase(hexstr, 16, 10);
        return res;
    },
};

Object.assign(exports, NumberBaseConverter);
