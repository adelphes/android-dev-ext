/*
    ADBClient: class to manage commands to ADB
*/
const JDWPSocket = require('./sockets/jdwpsocket');
const ADBSocket = require('./sockets/adbsocket');

/**
 * 
 * @param {string} data 
 * @param {boolean} [extended] 
 */
function parse_device_list(data, extended = false) {
    var lines = data.trim().split(/\r\n?|\n/);
    lines.sort();
    const devicelist = [];
    if (extended) {
        for (let i = 0, m; i < lines.length; i++) {
            try {
                m = JSON.parse(lines[i]);
            } catch (e) { continue; }
            if (!m) continue;
            m.num = i;
            devicelist.push(m);
        }
    } else {
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/([^\t]+)\t([^\t]+)/);
            if (!m) continue;
            devicelist.push({
                serial: m[1],
                status: m[2],
                num: i,
            });
        }
    }
    return devicelist;
}

class ADBClient {

    /**
     * @param {string} [deviceid]
     * @param {number} [adbPort] the port number to connect to ADB
     */
    constructor(deviceid, adbPort = ADBSocket.ADBPort) {
        this.deviceid = deviceid;
        this.adbsocket = null;
        this.jdwp_socket = null;
        this.adbPort = adbPort;
    }

    async test_adb_connection() {
        try {
            await this.connect_to_adb();
            await this.disconnect_from_adb();
        } catch(err) {
            // if we fail, still resolve the promise, passing the error
            return err;
        }
    }

    async list_devices() {
        await this.connect_to_adb()
        const data = await this.adbsocket.cmd_and_reply('host:devices');
        const devicelist = parse_device_list(data);
        await this.disconnect_from_adb();
        return devicelist;
    }

    /**
     * Return a list of debuggable pids from the device.
     * 
     * The `adb jdwp` command never terminates - it just posts each debuggable PID
     * as it comes online. Normally we just perform a single read of stdout
     * and terminate the connection, but if there are no pids available, the command
     * will wait forever.
     * @param {number} [timeout_ms] time to wait before we abort reading (and return an empty list).
     */
    async jdwp_list(timeout_ms) {
        await this.connect_to_adb();
        await this.adbsocket.cmd_and_status(`host:transport:${this.deviceid}`);
        /** @type {string} */
        let stdout;
        try {
            stdout = await this.adbsocket.cmd_and_read_stdout('jdwp', timeout_ms);
        } catch {
            // timeout or socket closed
            stdout = '';
        }
        await this.disconnect_from_adb();
        // do not sort the pid list - the debugger needs to pick the last one in the list.
        return stdout.trim().split(/\s+/).filter(x => x).map(s => parseInt(s, 10));
    }

    async named_jdwp_list(timeout_ms) {
        const named_pids = (await this.jdwp_list(timeout_ms))
            .map(pid => ({
                pid,
                name: '',
            }))
        if (!named_pids.length)
            return [];

        // retrieve the list of process names from the device
        const command = `for pid in ${named_pids.map(np => np.pid).join(' ')}; do cat /proc/$pid/cmdline;echo " $pid"; done`;
        const stdout = await this.shell_cmd({
            command,
            untilclosed: true,
        });
        // output should look something like...
        // com.example.somepkg 32721
        const lines = stdout.replace(/\0+/g,'').split(/\r?\n|\r/g);

        // scan the list looking for pids to match names with...
        for (let i = 0; i < lines.length; i++) {
            let entries = lines[i].match(/^\s*(.*)\s+(\d+)$/);
            if (!entries) {
                continue;
            }
            const pid = parseInt(entries[2], 10);
            const named_pid = named_pids.find(x => x.pid === pid);
            if (named_pid) {
                named_pid.name = entries[1];
            }
        }

        return named_pids;
    }

    /**
     * Setup ADB port-forwarding from a local port to a JDWP process
     * @param {{localport:number, jdwp:number}} o 
     */
    async jdwp_forward(o) {
        await this.connect_to_adb();
        await this.adbsocket.cmd_and_status(`host-serial:${this.deviceid}:forward:tcp:${o.localport};jdwp:${o.jdwp}`);
        await this.disconnect_from_adb();
        return true;
    }

    /**
     * remove all port-forwarding configs
     */
    async forward_remove_all() {
        await this.connect_to_adb();
        await this.adbsocket.cmd_and_status('host:killforward-all');
        await this.disconnect_from_adb();
        return true;
    }

    /**
     * Connect to the JDWP debugging client and perform the handshake
     * @param {{localport:number, onreply:()=>void, ondisconnect:()=>void}} o 
     */
    async jdwp_connect(o) {
        // note that upon success, this method does not close the connection (it must be left open for
        // future commands to be sent over the jdwp socket)
        this.jdwp_socket = new JDWPSocket(o.onreply, o.ondisconnect);
        await this.jdwp_socket.connect(o.localport)
        await this.jdwp_socket.start();
        return true;
    }

    /**
     * Send a JDWP command to the device
     * @param {{cmd}} o 
     */
    async jdwp_command(o) {
        // send the raw command over the socket - the reply is received via the JDWP monitor
        const reply = await this.jdwp_socket.cmd_and_reply(o.cmd);
        return reply.decoded;
    }

    /**
     * Disconnect the JDWP socket
     */
    async jdwp_disconnect() {
        await this.jdwp_socket.disconnect();
        return true;
    }

    /**
     * Run a shell command on the connected device
     * @param {{command:string, untilclosed?:boolean}} o 
     * @param {number} [timeout_ms]
     * @returns {Promise<string>}
     */
    async shell_cmd(o, timeout_ms) {
        await this.connect_to_adb();
        await this.adbsocket.cmd_and_status(`host:transport:${this.deviceid}`);
        const stdout = await this.adbsocket.cmd_and_read_stdout(`shell:${o.command}`, timeout_ms, o.untilclosed);
        await this.disconnect_from_adb();
        return stdout;
    }

    /**
     * Starts the Logcat monitor.
     * Logcat lines are passed back via onlog callback. If the device disconnects, onclose is called.
     * @param {{onlog:(e)=>void, onclose:(err)=>void}} o 
     */
    async startLogcatMonitor(o) {
        // onlog:function(e)
        // onclose:function(e)
        await this.connect_to_adb();
        await this.adbsocket.cmd_and_status(`host:transport:${this.deviceid}`);
        await this.adbsocket.cmd_and_status('shell:logcat -v time');
        // if there's no handler, just read the complete log and finish
        if (!o.onlog) {
            const logcatbuffer = await this.adbsocket.read_stdout();
            await this.disconnect_from_adb();
            return logcatbuffer;
        }

        // start the logcat monitor
        let logcatbuffer = Buffer.alloc(0);
        const next_logcat_lines = async () => {
            // read the next data from ADB
            let next_data;
            try{
                next_data = await this.adbsocket.read_stdout();
            } catch(e) {
                o.onclose(e);
                return;
            }
            logcatbuffer = Buffer.concat([logcatbuffer, next_data]);
            const last_newline_index = logcatbuffer.lastIndexOf(10) + 1;
            if (last_newline_index === 0) {
                // wait for a whole line
                next_logcat_lines();
                return;
            }
            // split into lines
            const logs = logcatbuffer.slice(0, last_newline_index).toString().split(/\r\n?|\n/);
            logcatbuffer = logcatbuffer.slice(last_newline_index);

            const e = {
                adbclient: this,
                logs,
            };
            o.onlog(e);
            next_logcat_lines();
        }
        next_logcat_lines();
    }

    endLogcatMonitor() {
        return this.adbsocket.disconnect();
    }

    /**
     * @param {ADBFileTransferParams} o 
     */
    async push_file(o) {
        await this.connect_to_adb();
        await this.adbsocket.cmd_and_status(`host:transport:${this.deviceid}`);
        await this.adbsocket.transfer_file(o);
        await this.adbsocket.disconnect();
        return true;
    }

    /**
     * @param {string} [hostname] 
     */
    connect_to_adb(hostname = '127.0.0.1') {
        this.adbsocket = new ADBSocket();
        return this.adbsocket.connect(this.adbPort, hostname);
    }

    disconnect_from_adb () {
        return this.adbsocket.disconnect();
    }
};

exports.ADBClient = ADBClient;
