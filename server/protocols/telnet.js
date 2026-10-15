'use strict';
// Telnet client (RFC 854) with option negotiation for ECHO, SGA, BINARY,
// TTYPE (RFC 1091) and NAWS (RFC 1073), plus Telnet special commands.
// Also provides the Raw TCP protocol (no negotiation).

const net = require('net');

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const CMD = { nop: 241, dm: 242, break: 243, ip: 244, ao: 245, ayt: 246, ec: 247, el: 248, ga: 249, eof: 236, susp: 237, abort: 238 };
const OPT = { BINARY: 0, ECHO: 1, SGA: 3, TTYPE: 24, NAWS: 31 };
const LOCAL_OK = new Set([OPT.BINARY, OPT.SGA, OPT.TTYPE, OPT.NAWS]); // we will do these
const REMOTE_OK = new Set([OPT.BINARY, OPT.ECHO, OPT.SGA]); // server may do these

function connectSocket(o, ctx) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: o.host, port: Number(o.port) });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('Connection timed out'));
    }, (Number(o.connectTimeout) || 20) * 1000);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.setNoDelay(true);
      if (Number(o.keepalive) > 0) sock.setKeepAlive(true, Number(o.keepalive) * 1000);
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function connectRaw(o, ctx) {
  const sock = await connectSocket({ ...o, port: o.port || 23 }, ctx);
  sock.on('data', (d) => ctx.data(d));
  sock.on('error', (e) => ctx.info(`Socket error: ${e.message}`, 'error'));
  sock.on('close', () => ctx.closed('Connection closed by remote host'));
  ctx.remoteEcho(false);
  return {
    write: (buf) => sock.write(buf),
    resize: () => {},
    special: () => {},
    close: () => sock.destroy(),
  };
}

async function connectTelnet(o, ctx) {
  const sock = await connectSocket({ ...o, port: o.port || 23 }, ctx);
  const term = (o.term || 'xterm-256color').toUpperCase();
  const us = {}; // options enabled on our side
  const him = {}; // options enabled on server side
  const pendUs = {};
  const pendHim = {};
  let cols = ctx.cols;
  let rows = ctx.rows;

  const send = (...bytes) => sock.write(Buffer.from(bytes));

  function sendNaws() {
    if (!us[OPT.NAWS]) return;
    const b = [IAC, SB, OPT.NAWS, (cols >> 8) & 255, cols & 255, (rows >> 8) & 255, rows & 255];
    // IAC bytes inside the subnegotiation must be doubled
    const out = [b[0], b[1], b[2]];
    for (const x of b.slice(3)) {
      out.push(x);
      if (x === IAC) out.push(IAC);
    }
    out.push(IAC, SE);
    send(...out);
  }

  function offerWill(opt) {
    if (!us[opt] && !pendUs[opt]) {
      pendUs[opt] = true;
      send(IAC, WILL, opt);
    }
  }
  function requestDo(opt) {
    if (!him[opt] && !pendHim[opt]) {
      pendHim[opt] = true;
      send(IAC, DO, opt);
    }
  }

  function onNegotiate(cmd, opt) {
    if (cmd === DO) {
      if (LOCAL_OK.has(opt)) {
        if (!us[opt]) {
          us[opt] = true;
          if (!pendUs[opt]) send(IAC, WILL, opt);
          pendUs[opt] = false;
          if (opt === OPT.NAWS) sendNaws();
        }
      } else send(IAC, WONT, opt);
    } else if (cmd === DONT) {
      if (us[opt] || pendUs[opt]) {
        const wasPending = pendUs[opt];
        us[opt] = pendUs[opt] = false;
        if (!wasPending) send(IAC, WONT, opt);
      }
    } else if (cmd === WILL) {
      if (REMOTE_OK.has(opt)) {
        if (!him[opt]) {
          him[opt] = true;
          if (!pendHim[opt]) send(IAC, DO, opt);
          pendHim[opt] = false;
          if (opt === OPT.ECHO) ctx.remoteEcho(true);
        }
      } else send(IAC, DONT, opt);
    } else if (cmd === WONT) {
      if (him[opt] || pendHim[opt]) {
        const wasPending = pendHim[opt];
        him[opt] = pendHim[opt] = false;
        if (!wasPending) send(IAC, DONT, opt);
        if (opt === OPT.ECHO) ctx.remoteEcho(false);
      }
    }
  }

  function onSubneg(buf) {
    const opt = buf[0];
    if (opt === OPT.TTYPE && buf[1] === 1 /* SEND */) {
      send(IAC, SB, OPT.TTYPE, 0 /* IS */, ...Buffer.from(term, 'ascii'), IAC, SE);
    }
  }

  // Byte-level parser that survives IAC sequences split across packets.
  let state = 'data';
  let negCmd = 0;
  let sbBuf = [];
  let lastWasCR = false;
  sock.on('data', (chunk) => {
    const out = [];
    for (const b of chunk) {
      switch (state) {
        case 'data':
          if (b === IAC) state = 'iac';
          else if (lastWasCR && b === 0 && !him[OPT.BINARY]) {
            /* CR NUL -> CR */
          } else out.push(b);
          lastWasCR = b === 13;
          break;
        case 'iac':
          if (b === IAC) {
            out.push(255);
            state = 'data';
          } else if (b === DO || b === DONT || b === WILL || b === WONT) {
            negCmd = b;
            state = 'neg';
          } else if (b === SB) {
            sbBuf = [];
            state = 'sb';
          } else state = 'data';
          break;
        case 'neg':
          onNegotiate(negCmd, b);
          state = 'data';
          break;
        case 'sb':
          if (b === IAC) state = 'sbiac';
          else sbBuf.push(b);
          break;
        case 'sbiac':
          if (b === SE) {
            onSubneg(sbBuf);
            state = 'data';
          } else {
            sbBuf.push(b);
            state = 'sb';
          }
          break;
      }
    }
    if (out.length) ctx.data(Buffer.from(out));
  });
  sock.on('error', (e) => ctx.info(`Socket error: ${e.message}`, 'error'));
  sock.on('close', () => ctx.closed('Connection closed by foreign host'));

  ctx.remoteEcho(false);
  if (!o.telnetPassive) {
    offerWill(OPT.NAWS);
    offerWill(OPT.TTYPE);
    offerWill(OPT.SGA);
    requestDo(OPT.SGA);
    requestDo(OPT.ECHO);
  }

  const newline = o.telnetNewline === false ? null : Buffer.from('\r\n');

  return {
    write: (buf) => {
      const out = [];
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (b === IAC) out.push(IAC, IAC);
        else if (b === 13 && !us[OPT.BINARY]) {
          if (newline && buf[i + 1] !== 10) out.push(13, 10);
          else if (!newline && buf[i + 1] !== 10) out.push(13, 0);
          else out.push(13);
        } else out.push(b);
      }
      sock.write(Buffer.from(out));
    },
    resize: (c, r) => {
      cols = c;
      rows = r;
      sendNaws();
    },
    special: (cmd) => {
      if (CMD[cmd]) send(IAC, CMD[cmd]);
    },
    close: () => sock.destroy(),
  };
}

module.exports = { connectTelnet, connectRaw };
