import dgram from "node:dgram";

// A DNS server on 127.0.0.1 for tests, answering A and AAAA questions from a
// table. A name missing from the table gets no reply at all, like a server
// that never answers.

export interface DnsRecords {
  A?: readonly string[];
  /** Written out in full: eight groups, no `::`. */
  AAAA?: readonly string[];
}

const A = 1;
const AAAA = 28;

export async function dnsServer(records: Record<string, DnsRecords>): Promise<{ server: string; queries: string[]; close: () => void }> {
  const queries: string[] = [];
  const socket = dgram.createSocket("udp4", (query, peer) => {
    // The question: its name as length-prefixed labels, then its type and class.
    const labels: string[] = [];
    let at = 12;
    while (query[at]! !== 0) {
      labels.push(query.subarray(at + 1, at + 1 + query[at]!).toString("ascii"));
      at += 1 + query[at]!;
    }
    const type = query.readUInt16BE(at + 1);
    const name = labels.join(".").toLowerCase();
    queries.push(`${name} ${type === A ? "A" : type === AAAA ? "AAAA" : type}`);
    const record = records[name];
    if (record === undefined) return;
    const addresses = (type === A ? record.A : type === AAAA ? record.AAAA : undefined) ?? [];
    const header = Buffer.alloc(12);
    header.writeUInt16BE(query.readUInt16BE(0), 0);
    header.writeUInt16BE(0x8180, 2); // A response, recursion available, no error.
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(addresses.length, 6);
    const answers = addresses.map((address) => {
      const data = type === A ? Buffer.from(address.split(".").map(Number)) : Buffer.from(address.split(":").flatMap((group) => [parseInt(group, 16) >> 8, parseInt(group, 16) & 0xff]));
      const answer = Buffer.alloc(12);
      answer.writeUInt16BE(0xc00c, 0); // The question's name.
      answer.writeUInt16BE(type, 2);
      answer.writeUInt16BE(1, 4);
      answer.writeUInt32BE(60, 6);
      answer.writeUInt16BE(data.length, 10);
      return Buffer.concat([answer, data]);
    });
    socket.send(Buffer.concat([header, query.subarray(12, at + 5), ...answers]), peer.port, peer.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return { server: `127.0.0.1:${socket.address().port}`, queries, close: () => socket.close() };
}
