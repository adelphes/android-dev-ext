const $ = require('./jq-promise');
const { btoa,D,E,getutf8bytes,fromutf8bytes,intToHex } = require('./util');
/*
    JDWP - The Java Debug Wire Protocol
*/
function _JDWP() {
	var gCommandId = 0;
	var gCommandList = [];
	var gEventCallbacks = {};

	function Command(name, cs, cmd, outdatafn, replydecodefn) {
		this.length = 11;
		this.id = ++gCommandId;
		this.flags = 0;
		this.commandset = cs;
		this.command = cmd;
		this.rawdata = outdatafn?outdatafn():[];

		this.length = 11 + this.rawdata.length;
		gCommandList[this.id] = this;

		this.name = name;
		this.replydecodefn = replydecodefn;
		this.deferred = $.Deferred();
	}

	Command.prototype = {
		promise : function() {
			return this.deferred.promise();
		},
		toRawString : function() {
			var s = '';
			s += String.fromCharCode((this.length >> 24)&255);
			s += String.fromCharCode((this.length >> 16)&255);
			s += String.fromCharCode((this.length >> 8)&255);
			s += String.fromCharCode((this.length)&255);
			s += String.fromCharCode((this.id >> 24)&255);
			s += String.fromCharCode((this.id >> 16)&255);
			s += String.fromCharCode((this.id >> 8)&255);
			s += String.fromCharCode((this.id)&255);
			s += String.fromCharCode(this.flags);
			s += String.fromCharCode(this.commandset);
			s += String.fromCharCode(this.command);
			var i=this.rawdata.length, j=0;
			while (--i>=0) {
				s += String.fromCharCode(this.rawdata[j++]);
			}
			return s;
		},
		tob64 : function() {
			return btoa(this.toRawString());
		}
	};

	function Reply(s) {
		this.length = s.charCodeAt(0) << 24;
		this.length += s.charCodeAt(1) << 16;
		this.length += s.charCodeAt(2) << 8;
		this.length += s.charCodeAt(3);
		this.id = s.charCodeAt(4) << 24;
		this.id += s.charCodeAt(5) << 16;
		this.id += s.charCodeAt(6) << 8;
		this.id += s.charCodeAt(7);
		this.flags = s.charCodeAt(8)|0;
		this.errorcode = s.charCodeAt(9) << 8;
		this.errorcode += s.charCodeAt(10);
		this.rawdata = new Array(s.length-11);
		var i=0, j=this.rawdata.length;
		while (--j>=0) {
			this.rawdata[i]=s.charCodeAt(i+11);
			i++;
		}
		this.command = gCommandList[this.id];
		
		if (this.errorcode===16484) {
            //	errorcode===16484 (0x4064) means a composite event command (set 64,cmd 100) sent from the VM
            this.errorcode=0;
            this.isevent=!0;
            this.decoded=DataCoder.decodeCompositeEvent({
				idx:0,
				data:this.rawdata.slice()
            });
            // call any registered event callbacks
            for (var i in this.decoded.events) {
            	var event = this.decoded.events[i];
            	var cbinfo = event.reqid && gEventCallbacks[event.reqid];
				if (cbinfo) {
					var e = { 
						data:cbinfo.callback.data,
						event:event,
						reply:this,
					};
					cbinfo.callback.fn.call(cbinfo.callback.ths, e);
				}
            }
            return;
		}
		
		if (this.errorcode !== 0) {
		    E(`JDWP command failed '${this.command.name}'. Error ${this.errorcode}`, this);
        }
		
		if (!this.errorcode && this.command && this.command.replydecodefn) {
			// try and decode the values
			this.decoded = this.command.replydecodefn({
				idx:0,
				data:this.rawdata.slice()
			});
			return;
		}

		this.decoded = {
            empty: true,
            errorcode: this.errorcode,
        };
	}

	this.decodereply = function(ths,s) {
		var reply = new Reply(s);
		if (reply.command) {
			reply.command.deferred.resolveWith(ths, [reply.decoded, reply.command, reply]);
		}
		return reply;
	};
	
	this.signaturetotype = function(s) {
		return DataCoder.signaturetotype(s);
	}

	this.setIDSizes = function(idsizes) {
		DataCoder._idsizes = idsizes;
	}

	var DataCoder = {
		_idsizes:null,

		nullRefValue: function() {
			if (!this._idsizes._nullreftypeid) {
				var x = '00', len = this._idsizes.reftypeidsize * 2; // each byte needs 2 chars
				while (x.length < len) x += x;
				this._idsizes._nullreftypeid = x.slice(0, len); // should be power of 2, but just in case...
			}
			return this._idsizes._nullreftypeid;
		},

		decodeString: function(o) {
			var rd = o.data;
			var utf8len=(rd[o.idx++]<<24)+(rd[o.idx++]<<16)+(rd[o.idx++]<<8)+(rd[o.idx++]);
			if (utf8len > 10000)
				utf8len = 10000;	// just to prevent hangs if the decoding is wrong
			var res=fromutf8bytes(o.data.slice(o.idx, o.idx+utf8len));
			o.idx+= utf8len;
			return res;
		},
		decodeLong: function(o, hexstring) {
			var rd = o.data;
			var res1=(rd[o.idx++]<<24)+(rd[o.idx++]<<16)+(rd[o.idx++]<<8)+(rd[o.idx++]);
			var res2=(rd[o.idx++]<<24)+(rd[o.idx++]<<16)+(rd[o.idx++]<<8)+(rd[o.idx++]);
			return intToHex(res1>>>0,8)+intToHex(res2>>>0,8);	// >>> 0 ensures +ve value
		},
		decodeInt: function(o) {
			var rd = o.data;
			var res=(rd[o.idx++]<<24)+(rd[o.idx++]<<16)+(rd[o.idx++]<<8)+(rd[o.idx++]);
			return res;
		},
		decodeByte: function(o) {
			var i = o.data[o.idx++];
			return i<128?i:i-256;
		},
		decodeShort: function(o) {
			var i = (o.data[o.idx++]<<8)+o.data[o.idx++];
			return i<32768?i:i-65536;
		},
		decodeChar: function(o) {
			return (o.data[o.idx++]<<8)+o.data[o.idx++];	// uint16
		},
		decodeBoolean: function(o) {
			return o.data[o.idx++] != 0;
		},
		decodeDecimal: function(bytes, signBits, exponentBits, fractionBits, eMin, eMax, littleEndian) {
			var totalBits = (signBits + exponentBits + fractionBits);

			var binary = "";
			for (var i = 0, l = bytes.length; i < l; i++) {
			var bits = bytes[i].toString(2);
			while (bits.length < 8) 
			  bits = "0" + bits;

			if (littleEndian)
			  binary = bits + binary;
			else
			  binary += bits;
			}

			var sign = (binary.charAt(0) == '1')?-1:1;
			var exponent = parseInt(binary.substr(signBits, exponentBits), 2) - eMax;
			var significandBase = binary.substr(signBits + exponentBits, fractionBits);
			var significandBin = '1'+significandBase;
			var i = 0;
			var val = 1;
			var significand = 0;

			if (exponent+eMax===((eMax*2)+1)) {
				if (significandBase.indexOf('1')<0)
					return sign>0?Number.POSITIVE_INFINITY:Number.NEGATIVE_INFINITY;
				return Number.NaN;
			}
			if (exponent == -eMax) {
			  if (significandBase.indexOf('1') == -1)
				  return 0;
			  else {
				  exponent = eMin;
				  significandBin = '0'+significandBase;
			  }
			}

			while (i < significandBin.length) {
			  significand += val * parseInt(significandBin.charAt(i));
			  val = val / 2;
			  i++;
			}

			return sign * significand * Math.pow(2, exponent);
		},
		decodeFloat: function(o) {
			var bytes = o.data.slice(o.idx, o.idx+=4);
			return this.decodeDecimal(bytes, 1, 8, 23, -126, 127, false);
		},
		decodeDouble: function(o) {
			var bytes = o.data.slice(o.idx, o.idx+=8);
			return this.decodeDecimal(bytes, 1, 11, 52, -1022, 1023, false);
		},
		decodeRef: function(o, bytes) {
			var rd = o.data;
			var res = '';
			while (--bytes>=0) {
				res += ('0'+rd[o.idx++].toString(16)).slice(-2);
		    }
			return res;
		},
		decodeTRef: function(o) {
			return this.decodeRef(o,this._idsizes.reftypeidsize);
		},
		decodeORef: function(o) {
			return this.decodeRef(o,this._idsizes.objectidsize);
		},
		decodeMRef: function(o) {
			return this.decodeRef(o,this._idsizes.methodidsize);
		},
		decodeRefType : function(o) {
			return this.mapvalue(this.decodeByte(o), [null,'class','interface','array']);
		},
		decodeStatus : function(o) {
			return this.mapflags(this.decodeInt(o), ['verified','prepared','initialized','error']);
		},
		decodeThreadStatus : function(o) {
			return ['zombie','running','sleeping','monitor','wait'][this.decodeInt(o)] || '';
		},
		decodeSuspendStatus : function(o) {
			return this.decodeInt(o) ? 'suspended': '';
		},
		decodeTaggedObjectID : function(o) {
			return this.decodeValue(o);
		},
		decodeValue : function(o) {
			var rd = o.data;
			return this.tagtodecoder(rd[o.idx++]).call(this, o);
		},
		tagtodecoder: function(tag) {
			switch (tag) {
				case 91: 
				case 76: 
				case 115:
				case 116:
				case 103:
				case 108:
				case 99:
					return this.decodeORef;
				case 66:
					return this.decodeByte;
				case 90:
					return this.decodeBoolean;
				case 67:
					return this.decodeChar;
				case 83:
					return this.decodeShort;
				case 70:
					return this.decodeFloat;
				case 73:
					return this.decodeInt;
				case 68:
					return this.decodeDouble;
				case 74:
					return this.decodeLong;
				case 86:
					return function() { return 'void'; };
			}
		},
		mapvalue : function(value,values) {
			return {value: value, string:values[value] };
		},
		mapflags : function(value,values) {
			var res = {value: value, string:'[]'};
			var flgs=[];
			for (var i=value,j=0;i;i>>=1) {
				if ((i&1)&&(values[j]))
					flgs.push(values[j]);
				j++;
			}
			res.string = '['+flgs.join('|')+']';
			return res;
		},
		decodeList: function(o, list) {
			var res = {};
			while (list.length) {
				var next = list.shift();
				for ( var key in next) {
				    switch(next[key]) {
					    case 'string': res[key]=this.decodeString(o); break;
					    case 'int': res[key]=this.decodeInt(o); break;
					    case 'long': res[key]=this.decodeLong(o); break;
					    case 'byte': res[key]=this.decodeByte(o); break;
					    case 'fref': res[key]=this.decodeRef(o,this._idsizes.fieldidsize); break;
					    case 'mref': res[key]=this.decodeRef(o,this._idsizes.methodidsize); break;
					    case 'oref': res[key]=this.decodeRef(o,this._idsizes.objectidsize); break;
					    case 'tref': res[key]=this.decodeRef(o,this._idsizes.reftypeidsize); break;
					    case 'frameid': res[key]=this.decodeRef(o,this._idsizes.frameidsize); break;
					    case 'reftype': res[key]=this.decodeRefType(o); break;
					    case 'status': res[key]=this.decodeStatus(o); break;
					    case 'location': res[key]=this.decodeLocation(o); break;
					    case 'signature': res[key]=this.decodeTypeFromSignature(o); break;
					    case 'codeindex': res[key]=this.decodeLong(o, true); break;
				    }
				}
			}
			return res;
		},
		decodeLocation : function(o) {
			return { 
				type: o.data[o.idx++],
				cid: this.decodeTRef(o),
				mid: this.decodeMRef(o),
				idx: this.decodeLong(o, true),
			};
		},
		decodeTypeFromSignature : function(o) {
			var sig = this.decodeString(o);
			return this.signaturetotype(sig);
		},
	    decodeCompositeEvent: function (o) {
			var rd = o.data;
	        var res = {};
    	    res.suspend = rd[o.idx++];
    	    res.events = [];
    	    var arrlen = this.decodeInt(o);
    	    while (--arrlen>=0) {
    	    	// all event types return kind+requestid as their first entries
        	    var event = { 
        	    	kind:{name:'', value:rd[o.idx++]},
				};
				var eventkinds = ['','step','breakpoint','framepop','exception','userdefined','threadstart','threadend','classprepare','classunload','classload'];
				event.kind.name = eventkinds[event.kind.value];
        	    switch(event.kind.value) {
        	        case 1: // step
        	        case 2: // breakpoint
            	        event.reqid = this.decodeInt(o);
            	        event.threadid = this.decodeORef(o);
            	        event.location = this.decodeLocation(o);
            	        break;
        	        case 4: // exception
            	        event.reqid = this.decodeInt(o);
            	        event.threadid = this.decodeORef(o);
            	        event.throwlocation = this.decodeLocation(o);
            	        event.exception = this.decodeTaggedObjectID(o);
            	        event.catchlocation = this.decodeLocation(o);	// 0 = uncaught
            	        break;
        	        case 6: // thread start
        	        case 7: // thread end
            	        event.reqid = this.decodeInt(o);
            	        event.threadid = this.decodeORef(o);
						event.state = event.kind.value === 6 ? 'start' : 'end';
						break;
        	        case 8: // classprepare
            	        event.reqid = this.decodeInt(o);
            	        event.threadid = this.decodeORef(o);
            	        event.reftype = this.decodeByte(o);
            	        event.typeid = this.decodeTRef(o);
            	        event.type = this.decodeTypeFromSignature(o);
            	        event.status = this.decodeStatus(o);
            	        break;
        	    }
        	    res.events.push(event);
    	    }
    	    return res;
    	},
	
		encodeByte : function(res, i) {
			res.push(i&255);
		},
		encodeBoolean : function(res, b) {
			res.push(b?1:0);
		},
		encodeShort : function(res, i) {
			res.push((i>>8)&255);
			res.push((i)&255);
		},
		encodeInt : function(res, i) {
			res.push((i>>24)&255);
			res.push((i>>16)&255);
			res.push((i>>8)&255);
			res.push((i)&255);
		},
		encodeChar: function(res, c) {
			// c can either be a 1 char string or an integer
			this.encodeShort(res, typeof c === 'string' ? c.charCodeAt(0) : c);
		},
		encodeString : function(res, s) {
			var utf8bytes = getutf8bytes(s);
			this.encodeInt(res, utf8bytes.length);
			for (var i=0; i < utf8bytes.length; i++)
				res.push(utf8bytes[i]);
		},
		encodeRef: function(res, ref) {
			if (ref === null) ref = this.nullRefValue();
		    for(var i=0; i < ref.length; i+=2) {
		        res.push(parseInt(ref.substring(i,i+2), 16));
	        }
		},
		encodeLong: function(res, l) {
		    for(var i=0; i < l.length; i+=2) {
		        res.push(parseInt(l.substring(i,i+2), 16));
	        }
		},
		encodeDouble: function(res, value) {
			var hiWord = 0, loWord = 0;
			switch (value) {
				case Number.POSITIVE_INFINITY: hiWord = 0x7FF00000; break;
				case Number.NEGATIVE_INFINITY: hiWord = 0xFFF00000; break;
				case +0.0: hiWord = 0x00000000; break;//0x40000000; break;
				case -0.0: hiWord = 0x80000000; break;//0xC0000000; break;
				default:
					if (Number.isNaN(value)) { hiWord = 0x7FF80000; break; }

					if (value <= -0.0) {
						hiWord = 0x80000000;
						value = -value;
					}

					var exponent = Math.floor(Math.log(value) / Math.log(2));
					var significand = Math.floor((value / Math.pow(2, exponent)) * Math.pow(2, 52));

					loWord = significand & 0xFFFFFFFF;
					significand /= Math.pow(2, 32);

					exponent += 1023;
					if (exponent >= 0x7FF) {
						exponent = 0x7FF;
						significand = 0;
					} else if (exponent < 0) exponent = 0;

					hiWord = hiWord | (exponent << 20);
					hiWord = hiWord | (significand & ~(-1 << 20));
				break;
			}
			this.encodeInt(res, hiWord);
			this.encodeInt(res, loWord);
		},
		encodeFloat: function(res, value) {
			var bytes = 0;
			switch (value) {
				case Number.POSITIVE_INFINITY: bytes = 0x7F800000; break;
				case Number.NEGATIVE_INFINITY: bytes = 0xFF800000; break;
				case +0.0: bytes = 0x00000000; break;//0x40000000; break;
				case -0.0: bytes = 0x80000000; break;//0xC0000000l
				default:
					if (Number.isNaN(value)) { bytes = 0x7FC00000; break; }

					if (value <= -0.0) {
						bytes = 0x80000000;
						value = -value;
					}

					var exponent = Math.floor(Math.log(value) / Math.log(2));
					var significand = ((value / Math.pow(2, exponent)) * 0x00800000) | 0;

					exponent += 127;
					if (exponent >= 0xFF) {
						exponent = 0xFF;
						significand = 0;
					} else if (exponent < 0) exponent = 0;

					bytes = bytes | (exponent << 23);
					bytes = bytes | (significand & ~(-1 << 23));
				break;
			}

			this.encodeInt(res, bytes);
		},
		encodeValue: function(res, key, data) {
			switch(key) {
				case 'byte': this.encodeByte(res, data); break;
				case 'short': this.encodeShort(res, data); break;
				case 'int': this.encodeInt(res, data); break;
				case 'long': this.encodeLong(res, data); break;
				case 'boolean': this.encodeBoolean(res, data); break;
				case 'char': this.encodeChar(res, data); break;
				case 'float': this.encodeFloat(res, data); break;
				case 'double': this.encodeDouble(res, data); break;
				// note that strings are encoded as object references...
				case 'oref': this.encodeRef(res,data); break;
			}
		},

		encodeTaggedValue: function(res, key, data) {
			switch(key) {
				case 'byte': res.push(66); break;
				case 'short': res.push(83); break;
				case 'int':  res.push(73); break;
				case 'long': res.push(74); break;
				case 'boolean': res.push(90); break;
				case 'char': res.push(67); break;
				case 'float': res.push(70); break;
				case 'double': res.push(68); break;
				case 'void': res.push(86); break;
				// note that strings are encoded as object references...
				case 'oref': res.push(76); break;
			}
			this.encodeValue(res, key, data);
		},

		signaturetotype:function(signature) {
			var m = signature.match(/^L([^$]+)\/([^$\/]+)(\$.+)?;$/);
			if (m) {
				return {
					signature: signature,
					package: m[1].replace(/\//g,'.'),
					typename: (m[2]+(m[3]||'')).replace(/\$(?=[^\d])/g,'.'),
					anonymous: /\$\d/.test(m[3]),
				}
			}
			m = signature.match(/^(\[+)(.+)$/);
			if (m) {
				var elementtype = this.signaturetotype(m[1].slice(0,-1) + m[2]);
				return {
					signature:signature,
					arraydims:m[1].length,
					elementtype: elementtype,
					typename:elementtype.typename+'[]',
				}
			}
			var primitivetypes = {
				B: { signature:'B', typename:'byte', primitive:true, },
				C: { signature:'C', typename:'char', primitive:true, },
				F: { signature:'F', typename:'float', primitive:true, },
				D: { signature:'D', typename:'double', primitive:true, },
				I: { signature:'I', typename:'int', primitive:true, },
				J: { signature:'J', typename:'long', primitive:true, },
				S: { signature:'S', typename:'short', primitive:true, },
				V: { signature:'V', typename:'void', primitive:true, },
				Z: { signature:'Z', typename:'boolean', primitive:true, },
			}
			var res = (signature.length===1)?primitivetypes[signature[0]]:null;
			if (res) return res;
			return {
				signature:signature,
				typename:signature,
				invalid:true,
			}
		},
	};

	//var Commands = {
	this.Commands = {
		version:function() {
			return new Command('version',1, 1,
				null,
				function (o) {
					return DataCoder.decodeList(o, [{description:'string'},{major:'int'},{minor:'int'},{version:'string'},{name:'string'}]);
				}
			);
		},
		idsizes:function() {
			return new Command('IDSizes', 1, 7,
				function() {
					return [];
				},
				function(o) {
					return DataCoder.decodeList(o, [{fieldidsize:'int'},{methodidsize:'int'},{objectidsize:'int'},{reftypeidsize:'int'},{frameidsize:'int'}]);
				}
			);
		},
		classinfo:function(ci) {
			return new Command('ClassesBySignature:'+ci.name, 1, 2,
				function() {
					var res=[];
					DataCoder.encodeString(res, ci.type.signature);
					return res;
				},
				function(o) {
					var arrlen = DataCoder.decodeInt(o);
					var res = [];
					while (--arrlen>=0) {
						res.push(DataCoder.decodeList(o, [{reftype:'reftype'},{typeid:'tref'},{status:'status'}]));
					}
					return res;
				}
			);
		},
		fields:function(ci) {
    		// not supported by Dalvik
			return new Command('Fields:'+ci.name, 2, 4,
				function() {
					var res=[];
					DataCoder.encodeRef(res, ci.info.typeid);
					return res;
				},
				function(o) {
					var arrlen = DataCoder.decodeInt(o);
					var res = [];
					while (--arrlen>=0) {
						res.push(DataCoder.decodeList(o, [{fieldid:'fref'},{name:'string'},{sig:'string'},{modbits:'int'}]));
					}
					return res;
				}
			);
		},
		methods:function(ci) {
    		// not supported by Dalvik - use methodsWithGeneric
			return new Command('Methods:'+ci.name, 2, 5,
				function() {
					var res=[];
					DataCoder.encodeRef(res, ci.info.typeid);
					return res;
				},
				function(o) {
					var arrlen = DataCoder.decodeInt(o);
					var res = [];
					while (--arrlen>=0) {
						res.push(DataCoder.decodeList(o, [{methodid:'mref'},{name:'string'},{sig:'string'},{modbits:'int'}]));
					}
					return res;
				}
			);
		},
		GetStaticFieldValues:function(typeid, fields) {
			return new Command('GetStaticFieldValues:'+typeid, 2, 6,
				function() {
					var res=[];
					DataCoder.encodeRef(res, typeid);
					DataCoder.encodeInt(res, fields.length);
					for (var i in fields) {
						DataCoder.encodeRef(res, fields[i].fieldid);
					}
					return res;
				},
				function(o) {
					var res = [];
					var arrlen = DataCoder.decodeInt(o);
					while (--arrlen>=0) {
    					var v = DataCoder.decodeValue(o);
					    res.push(v);
					}
					return res;
				}
			);
		},
		sourcefile:function(ci) {
			return new Command('SourceFile:'+ci.name, 2, 7,
				function() {
					var res=[];
					DataCoder.encodeRef(res, ci.info.typeid);
					return res;
				},
				function(o) {
					return [{'sourcefile':DataCoder.decodeString(o)}];
				}
			);
		},
		fieldsWithGeneric:function(ci) {
			return new Command('FieldsWithGeneric:'+ci.name, 2, 14,
				function() {
					var res=[];
					DataCoder.encodeRef(res, ci.info.typeid);
					return res;
				},
				function(o) {
					var arrlen = DataCoder.decodeInt(o);
					var res = [];
					while (--arrlen>=0) {
						var field = DataCoder.decodeList(o, [{fieldid:'fref'},{name:'string'},{type:'signature'},{genericsig:'string'},{modbits:'int'}]);
						field.typeid = ci.info.typeid;
						res.push(field);
					}
					return res;
				}
			);
		},
		methodsWithGeneric:function(ci) {
			return new Command('MethodsWithGeneric:'+ci.name, 2, 15,
				function() {
					var res=[];
					DataCoder.encodeRef(res, ci.info.typeid);
					return res;
				},
				function(o) {
					var arrlen = DataCoder.decodeInt(o);
					var res = [];
					while (--arrlen>=0) {
						res.push(DataCoder.decodeList(o, [{methodid:'mref'},{name:'string'},{sig:'string'},{genericsig:'string'},{modbits:'int'}]));
					}
					return res;
				}
			);
		},
		superclass:function(ci) {
			return new Command('Superclass:'+ci.name, 3, 1,
				function() {
					var res=[];
					DataCoder.encodeRef(res, ci.info.typeid);
					return res;
				},
				function(o) {
					return DataCoder.decodeTRef(o);
				}
			);
		},
		signature:function(typeid) {
			return new Command('Signature:'+typeid, 2, 1,
				function() {
					var res=[];
					DataCoder.encodeRef(res, typeid);
					return res;
				},
				function(o) {
					return DataCoder.decodeTypeFromSignature(o);
				}
			);
		},
		// nestedTypes is not implemented on android
		nestedTypes:function(ci) {
			return new Command('NestedTypes:'+ci.name, 2, 8,
				function() {
					var res=[];
					DataCoder.encodeRef(res, ci.info.typeid);
					return res;
				},
				function(o) {
					var res=[];
					var arrlen = DataCoder.decodeInt(o);
					while (--arrlen>=0) {
    					var v = DataCoder.decodeList(o, [{reftype:'reftype'},{typeid:'tref'}]);
					    res.push(v);
					}
					return res;
				}
			);
		},
		lineTable:function(ci, mi) {
			return new Command('Linetable:'+ci.name+","+mi.name, 6, 1,
				function() {
					var res=[];
					DataCoder.encodeRef(res, ci.info.typeid);
					DataCoder.encodeRef(res, mi.methodid);
					return res;
				},
				function(o) {
					var res = {};
					res.start = DataCoder.decodeLong(o, true);
					res.end = DataCoder.decodeLong(o, true);
					res.lines = [];
					var arrlen = DataCoder.decodeInt(o);
					while (--arrlen>=0) {
    					var line = DataCoder.decodeList(o, [{linecodeidx:'codeindex'},{linenum:'int'}]);
					    res.lines.push(line);
					}
					// sort the lines by...um..line number
					res.lines.sort(function(a,b) {
						return a.linenum-b.linenum
							|| a.linecodeidx-b.linecodeidx;
					})
					return res;
				}
			);
		},
		VariableTableWithGeneric:function(ci, mi) {
		    // VariableTable is not supported by Dalvik
			return new Command('VariableTableWithGeneric:'+ci.name+","+mi.name, 6, 5,
				function() {
					var res=[];
					DataCoder.encodeRef(res, ci.info.typeid);
					DataCoder.encodeRef(res, mi.methodid);
					return res;
				},
				function(o) {
					var res = {};
					res.argCnt = DataCoder.decodeInt(o);
					res.vars = [];
					var arrlen = DataCoder.decodeInt(o);
					while (--arrlen>=0) {
    					var v = DataCoder.decodeList(o, [{codeidx:'codeindex'},{name:'string'},{type:'signature'},{genericsig:'string'},{length:'int'},{slot:'int'}]);
					    res.vars.push(v);
					}
					return res;
				}
			);
		},
		Frames:function(threadid, start, count) {
			return new Command('Frames:'+threadid, 11, 6,
				function() {
					var res=[];
					DataCoder.encodeRef(res, threadid);
					DataCoder.encodeInt(res, start||0);
					DataCoder.encodeInt(res, count||-1);
					return res;
				},
				function(o) {
					var res = [];
					var arrlen = DataCoder.decodeInt(o);
					while (--arrlen>=0) {
    					var v = DataCoder.decodeList(o, [{frameid:'frameid'},{location:'location'}]);
					    res.push(v);
					}
					return res;
				}
			);
		},
		GetStackValues:function(threadid, frameid, slots) {
			return new Command('GetStackValues:'+threadid, 16, 1,
				function() {
					var res=[];
					DataCoder.encodeRef(res, threadid);
					DataCoder.encodeRef(res, frameid);
					DataCoder.encodeInt(res, slots.length);
					for (var i in slots) {
						DataCoder.encodeInt(res, slots[i].slot);
						DataCoder.encodeByte(res, slots[i].tag);
					}
					return res;
				},
				function(o) {
					var res = [];
					var arrlen = DataCoder.decodeInt(o);
					while (--arrlen>=0) {
    					var v = DataCoder.decodeValue(o);
					    res.push(v);
					}
					return res;
				}
			);
		},
		SetStackValue:function(threadid, frameid, slot, data) {
			return new Command('SetStackValue:'+threadid, 16, 2,
				function() {
					var res=[];
					DataCoder.encodeRef(res, threadid);
					DataCoder.encodeRef(res, frameid);
					DataCoder.encodeInt(res, 1);
					DataCoder.encodeInt(res, slot);
					DataCoder.encodeTaggedValue(res, data.valuetype, data.value);
					return res;
				},
				function(o) {
					// there's no return data - if we reach here, the update was successfull
					return true;
				}
			);
		},
		GetObjectType:function(objectid) {
			return new Command('GetObjectType:'+objectid, 9, 1,
				function() {
					var res=[];
					DataCoder.encodeRef(res, objectid);
					return res;
				},
				function(o) {
					DataCoder.decodeRefType(o);
					return DataCoder.decodeTRef(o);
				}
			);
		},
		GetFieldValues:function(objectid, fields) {
			return new Command('GetFieldValues:'+objectid, 9, 2,
				function() {
					var res=[];
					DataCoder.encodeRef(res, objectid);
					DataCoder.encodeInt(res, fields.length);
					for (var i in fields) {
						DataCoder.encodeRef(res, fields[i].fieldid);
					}
					return res;
				},
				function(o) {
					var res = [];
					var arrlen = DataCoder.decodeInt(o);
					while (--arrlen>=0) {
    					var v = DataCoder.decodeValue(o);
					    res.push(v);
					}
					return res;
				}
			);
		},
		SetFieldValue:function(objectid, field, data) {
			return new Command('SetFieldValue:'+objectid, 9, 3,
				function() {
					var res=[];
					DataCoder.encodeRef(res, objectid);
					DataCoder.encodeInt(res, 1);
					DataCoder.encodeRef(res, field.fieldid);
					DataCoder.encodeValue(res, data.valuetype, data.value);
					return res;
				},
				function(o) {
					// there's no return data - if we reach here, the update was successfull
					return true;
				}
			);
		},
		InvokeMethod:function(objectid, threadid, classid, methodid, args) {
			return new Command('InvokeMethod:'+[objectid, threadid, classid, methodid, args].join(','), 9, 6,
				function() {
					var res=[];
					DataCoder.encodeRef(res, objectid);
					DataCoder.encodeRef(res, threadid);
					DataCoder.encodeRef(res, classid);
					DataCoder.encodeRef(res, methodid);
					DataCoder.encodeInt(res, args.length);
					args.forEach(arg => DataCoder.encodeValue(res, arg.type, arg.value));
					DataCoder.encodeInt(res, 1);	// INVOKE_SINGLE_THREADED
					return res;
				},
				function(o) {
					return {
						return_value: DataCoder.decodeValue(o),
						exception: DataCoder.decodeTaggedObjectID(o),
					}
				}
			);
		},
		GetArrayLength:function(arrobjid) {
			return new Command('GetArrayLength:'+arrobjid, 13, 1,
				function() {
					var res=[];
					DataCoder.encodeRef(res, arrobjid);
					return res;
				},
				function(o) {
					return DataCoder.decodeInt(o);
				}
			);
		},
		GetArrayValues:function(arrobjid, idx, count) {
			return new Command('GetArrayValues:'+arrobjid, 13, 2,
				function() {
					var res=[];
					DataCoder.encodeRef(res, arrobjid);
					DataCoder.encodeInt(res, idx);
					DataCoder.encodeInt(res, count);
					return res;
				},
				function(o) {
					var res = [];
					var tag = DataCoder.decodeByte(o);
					var decodefn = DataCoder.tagtodecoder(tag);
					// objects are decoded as values
					if (decodefn===DataCoder.decodeORef)
						decodefn = DataCoder.decodeValue;
					var arrlen = DataCoder.decodeInt(o);
					while (--arrlen>=0) {
    					var v = decodefn.call(DataCoder, o);
					    res.push(v);
					}
					return res;
				}
			);
		},
		SetArrayElements:function(arrobjid, idx, count, data) {
			return new Command('SetArrayElements:'+arrobjid, 13, 3,
				function() {
					var res=[];
					DataCoder.encodeRef(res, arrobjid);
					DataCoder.encodeInt(res, idx);
					DataCoder.encodeInt(res, count);
					for (var i=0; i < count; i++)
						DataCoder.encodeValue(res, data.valuetype, data.value);
					return res;
				},
				function(o) {
					// there's no return data - if we reach here, the update was successfull
					return true;
				}
			);
		},
		GetStringValue:function(strobjid) {
			return new Command('GetStringValue:'+strobjid, 10, 1,
				function() {
					var res=[];
					DataCoder.encodeRef(res, strobjid);
					return res;
				},
				function(o) {
					return DataCoder.decodeString(o);
				}
			);
		},
		CreateStringObject:function(text) {
			return new Command('CreateStringObject:'+text.substring(0,20), 1, 11,
				function() {
					var res=[];
					DataCoder.encodeString(res, text);
					return res;
				},
				function(o) {
					return DataCoder.decodeORef(o);
				}
			);
		},
		SetEventRequest:function(kindname, kind, suspend, modifiers, modifiercb, onevent) {
			return new Command('SetEventRequest:'+kindname, 15, 1,
				function() {
					var res=[kind,suspend];
					DataCoder.encodeInt(res, modifiers.length);
					for (var i=0;i<modifiers.length; i++) {
                        modifiercb(modifiers[i], i, res);
					}
					return res;
				},
				function(o) {
					var res = {
						id:DataCoder.decodeInt(o),
						callback: onevent,
					};
					gEventCallbacks[res.id] = res;
					D('Accepted event request: '+kindname+', id:'+res.id);
					return res;
				}
			);
		},
		ClearEvent:function(kindname, kind, requestid) {
			return new Command('ClearEvent:'+kindname, 15, 2,
				function() {
					var res=[kind];
					DataCoder.encodeInt(res, requestid);
					D('Clearing event request: '+kindname+', id:'+requestid);
					return res;
				}
			);
		},
		SetSingleStep:function(steptype, threadid, onevent) {
			// a wrapper around SetEventRequest
			var stepdepths = {into:0,over:1,out:2};
			var mods =[{
			    modkind:10, // step
			    threadid: threadid,
			    size:1,// =Line
			    depth:stepdepths[steptype],
		    }];
			// kind(1=singlestep)
			// suspendpolicy(0=none,1=event-thread,2=all)
			return this.SetEventRequest("step",1,1,mods,
			    function(m1, i, res) {
					res.push(m1.modkind);
					DataCoder.encodeRef(res, m1.threadid);
					DataCoder.encodeInt(res, m1.size);
					DataCoder.encodeInt(res, m1.depth);
			    },
			    onevent
			);
		},
		SetBreakpoint:function(ci, mi, idx, hitcount, onevent) {
			// a wrapper around SetEventRequest
			var mods = [{
			    modkind:7, // location
			    loc:{ type:ci.info.reftype.value, cid:ci.info.typeid, mid:mi.methodid, idx:idx },
				encode(res) {
					res.push(this.modkind);
					res.push(this.loc.type);
					DataCoder.encodeRef(res, this.loc.cid);
					DataCoder.encodeRef(res, this.loc.mid);
					DataCoder.encodeLong(res, this.loc.idx);
				}
		    }];
			if (hitcount > 0) {
				// remember when setting a hitcount, the event is automatically cancelled after being fired
				mods.unshift({
					modkind:1,
					count: hitcount,
					encode(res) {
						res.push(this.modkind);
						DataCoder.encodeInt(res, this.count);
					}
				})
			}
			// kind(2=breakpoint)
			// suspendpolicy(0=none,1=event-thread,2=all)
			return this.SetEventRequest("breakpoint",2,1,mods,
			    function(m, i, res) {
					m.encode(res,i);
			    },
			    onevent
			);
		},
		ClearStep:function(requestid) {
			// kind(1=step)
			return this.ClearEvent("step",1,requestid);
		},
		ClearBreakpoint:function(requestid) {
			// kind(2=breakpoint)
			return this.ClearEvent("breakpoint",2,requestid);
		},
		ThreadStartNotify:function(onevent) {
			// a wrapper around SetEventRequest
			var mods = [];
			// kind(6=threadstart)
			// suspendpolicy(0=none,1=event-thread,2=all)
			return this.SetEventRequest("threadstart",6,1,mods,
			    function() {},
			    onevent
			);
		},
		ThreadEndNotify:function(onevent) {
			// a wrapper around SetEventRequest
			var mods = [];
			// kind(7=threadend)
			// suspendpolicy(0=none,1=event-thread,2=all)
			return this.SetEventRequest("threadend",7,1,mods,
			    function() {},
			    onevent
			);
		},
		OnClassPrepare:function(pattern, onevent) {
			// a wrapper around SetEventRequest
			var mods = [{
			    modkind:5, // classmatch
			    pattern: pattern,
		    }];
			// kind(8=classprepare)
			// suspendpolicy(0=none,1=event-thread,2=all)
			return this.SetEventRequest("classprepare",8,2,mods,
			    function(m1, i, res) {
					res.push(m1.modkind);
					DataCoder.encodeString(res, m1.pattern);
			    },
			    onevent
			);
		},
		ClearExceptionBreak:function(requestid) {
			// kind(4=exception)
			return this.ClearEvent("exception",4,requestid);
		},
		SetExceptionBreak:function(pattern, caught, uncaught, onevent) {
			// a wrapper around SetEventRequest
			var mods = [{
				modkind:8,	// exceptiononly
				reftypeid: DataCoder.nullRefValue(),	// exception class
				caught: caught,
				uncaught: uncaught,
			}];
			pattern && mods.unshift({
				modkind:5, // classmatch
				pattern: pattern,
			});
			// kind(4=exception)
			// suspendpolicy(0=none,1=event-thread,2=all)
			return this.SetEventRequest("exception",4,1,mods,
			    function(m, i, res) {
					res.push(m.modkind);
					switch(m.modkind) {
						case 5: DataCoder.encodeString(res, m.pattern); break;
						case 8:
							DataCoder.encodeRef(res, m.reftypeid);
							DataCoder.encodeBoolean(res, m.caught);
							DataCoder.encodeBoolean(res, m.uncaught);
							break;
					}
			    },
			    onevent
			);
		},
		allclasses:function() {
			// not supported by android
		},
		AllClassesWithGeneric:function() {
			return new Command('allclasses',1,20,
				null,
				function(o) {
					var res = [];
					var arrlen = DataCoder.decodeInt(o);
					while (--arrlen>=0) {
						res.push(DataCoder.decodeList(o, [{reftype:'reftype'},{typeid:'tref'},{type:'signature'},{genericSignature:'string'},{status:'status'}]));
					}
					return res;
				}
			);
		},
		suspend:function() {
			return new Command('suspend',1, 8, null, null);
		},
		resume:function() {
			return new Command('resume',1, 9, null, null);
		},
		suspendthread:function(threadid) {
			return new Command('suspendthread:'+threadid,11, 2, 
				function() {
					var res = [];
					DataCoder.encodeRef(res, this);
					return res;
				}.bind(threadid),
			 	null
			);
		},
		resumethread:function(threadid) {
			return new Command('resumethread:'+threadid,11, 3, 
				function() {
					var res = [];
					DataCoder.encodeRef(res, this);
					return res;
				}.bind(threadid),
			 	null
			);
		},
		allthreads:function() {
			return new Command('allthreads',1, 4, 
				null, 
				function(o) {
					var res = [];
					var arrlen = DataCoder.decodeInt(o);
					while (--arrlen>=0) {
						res.push(DataCoder.decodeTRef(o));
					}
					return res;
				}
			);
		},
		threadname:function(threadid) {
			return new Command('threadname',11,1, 
				function() {
					var res=[];
					DataCoder.encodeRef(res, this);
					return res;
				}.bind(threadid),
				function(o) {
					return DataCoder.decodeString(o);
				}
			);
		},
		threadstatus:function(threadid) {
			return new Command('threadstatus',11,4, 
				function() {
					var res=[];
					DataCoder.encodeRef(res, this);
					return res;
				}.bind(threadid),
				function(o) {
					return {
						thread: DataCoder.decodeThreadStatus(o),
						suspend: DataCoder.decodeSuspendStatus(o),
					}
				}
			);
		},
	};
}

exports._JDWP = _JDWP;
