const AndroidSocket = require('./androidsocket');

/**
 * Manages a JDWP connection to the device
 * The debugger uses ADB to setup JDWP port forwarding to the device - this class
 * connects to the local forwarding port
 */
class JDWPSocket extends AndroidSocket {
    constructor() {
        super('JDWP')
        this.cmds_in_progress = new Map();
        this.cmd_queue = [];
    }

    /**
     * Performs the JDWP handshake and begins reading the socket for JDWP events/replies
     * @param {function} decode_reply function used for decoding raw JDWP data
     */
    async perform_handshake(decode_reply) {
        const handshake = 'JDWP-Handshake';
        await this.write_bytes(handshake);
        const handshake_reply = await this.read_bytes(handshake.length, 'latin1');
        if (handshake_reply !== handshake) {
            throw new Error('JDWP handshake failed');
        }
        const next_jdwp_reply = async () => {
            let data;
            try {
                data = await this.read_bytes('length+data', 'latin1')
            } catch (e) {
                // ignore socket closed errors (sent when the debugger disconnects)
                if (!/socket closed/i.test(e.message))
                    throw e;
                return;
            }
            const reply = decode_reply(data);
            const on_reply = this.cmds_in_progress.get(reply.command);
            if (on_reply) {
                on_reply(reply);
            }
            next_jdwp_reply();
        }
        next_jdwp_reply();
        return true;
    }

    start_next_cmd() {
        const next = this.cmd_queue[0];
        if (next) {
            next.resolve(next.command);
        }
    }

    async process_cmd(command) {
        const wait_for_response = new Promise(resolve => {
            this.cmds_in_progress.set(command, reply => {
                this.cmds_in_progress.delete(command);
                resolve(reply);
            });
        });
        await this.write_bytes(Buffer.from(command.toRawString(), 'latin1'));
        return wait_for_response;
    }

    cmd_and_reply(command) {
        const p = new Promise(resolve => {
            this.cmd_queue.push({
                command,
                resolve
            })
        })
            .then(command => this.process_cmd(command))
            .then(reply => {
                this.cmd_queue.shift();
                this.start_next_cmd();
                if (reply.errorcode) {
                    throw new Error(`JDWP command failed '${reply.command.name}'. Error ${reply.errorcode}`);
                }
                return reply;
            });

        if (this.cmd_queue.length === 1) {
            this.start_next_cmd();
        }
        return p;
    }
}

module.exports = JDWPSocket;
