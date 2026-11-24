import {readFileSync} from 'node:fs';
import {createGateway,type GatewayConfig} from './gateway';
const file=process.argv[2];if(!file)throw new Error('Supply a private gateway configuration file');
const config=JSON.parse(readFileSync(file,'utf8')) as GatewayConfig;
const server=createGateway(config);console.log(`ST gateway listening on loopback:${server.port}`);
