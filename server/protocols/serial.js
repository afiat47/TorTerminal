'use strict';
// Serial console (COM ports / ttyUSB). Requires the optional `serialport` package.

let SerialPort = null;
try {
  ({ SerialPort } = require('serialport'));
} catch {}

const available = () => !!SerialPort;

async function listPorts() {
  if (!SerialPort) return [];
  return (await SerialPort.list()).map((p) => ({ path: p.path, manufacturer: p.manufacturer, friendlyName: p.friendlyName }));
}

async function connect(o, ctx) {
  if (!SerialPort) throw new Error('Serial support not installed (npm install serialport)');
  const flow = o.flowControl || 'none';
  const port = new SerialPort({
    path: o.serialPort,
    baudRate: Number(o.baudRate) || 9600,
    dataBits: Number(o.dataBits) || 8,
    stopBits: Number(o.stopBits) || 1,
    parity: o.parity || 'none',
    rtscts: flow === 'rtscts',
    xon: flow === 'xonxoff',
    xoff: flow === 'xonxoff',
    autoOpen: false,
  });
  await new Promise((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
  port.on('data', (d) => ctx.data(d));
  port.on('error', (e) => ctx.info(`Serial error: ${e.message}`, 'error'));
  port.on('close', () => ctx.closed('Serial port closed'));
  ctx.remoteEcho(true);

  const pulse = (flag, ms) => {
    port.set({ [flag]: true }, () => setTimeout(() => port.set({ [flag]: false }, () => {}), ms));
  };
  return {
    write: (buf) => port.write(buf),
    resize: () => {},
    special: (cmd) => {
      if (cmd === 'break') pulse('brk', 300);
      else if (cmd === 'dtr') pulse('dtr', 300);
      else if (cmd === 'rts') pulse('rts', 300);
    },
    close: () => port.isOpen && port.close(),
  };
}

module.exports = { connect, listPorts, available };
