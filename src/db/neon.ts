import { Pool } from '@neondatabase/serverless';
import type { Database,Queryable } from './database.js';

export type DatabaseRole='news_runtime'|'news_collector'|'news_quality';
export function validateNeonUrl(value:string|undefined):string {
  try {
    const url=new URL(value??'');
    if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname.endsWith('.neon.tech')||!url.username||!url.password
      ||url.searchParams.get('sslmode')!=='require')throw Error();
    return value!;
  }catch{throw new Error('NEON_DATABASE_URL_INVALID');}
}

type Client={query(sql:string,params?:unknown[]):Promise<unknown>;release(destroy?:boolean):void};
export type TransactionPool={connect():Promise<Client>;end():Promise<void>};
function queries(client:Client):Queryable {
  return {query:async<T>(sql:string,params?:unknown[])=>{
    const result=await client.query(sql,params) as {rows:T[]};return {rows:result.rows};
  },exec:sql=>client.query(sql)};
}

// Interactive transactions stay on ONE checked-out WebSocket connection.
// No transaction retry: an ambiguous COMMIT could already have reserved usage.
export function pooledDatabase(pool:TransactionPool,role?:DatabaseRole,destroyAfterTransaction=false):Database {
  const db:Database={
    query:<T>(sql:string,params?:unknown[])=>db.transaction(tx=>tx.query<T>(sql,params)),
    exec:sql=>db.transaction(tx=>tx.exec(sql)),
    transaction:async work=>{
      const client=await pool.connect();let destroy=false;
      try {
        await client.query('BEGIN');
        if(role) {
          const check=await client.query(`SELECT current_user AS name,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
            EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND c.relkind='r' AND pg_has_role(current_user,c.relowner,'MEMBER')) AS owns_tables,
            EXISTS(SELECT 1 FROM pg_roles elevated WHERE (elevated.rolsuper OR elevated.rolbypassrls OR elevated.rolcreaterole)
              AND pg_has_role(current_user,elevated.oid,'MEMBER')) AS elevated
            FROM pg_roles r WHERE r.rolname=current_user`) as {rows:Record<string,unknown>[]};
          const r=check.rows[0];
          if(!r||r.name!==role||r.rolsuper||r.rolbypassrls||r.rolcreaterole||r.rolcreatedb||r.owns_tables||r.elevated)throw Error('UNSAFE_DATABASE_ROLE');
        }
        await client.query("SELECT set_config('statement_timeout','30000',true),set_config('idle_in_transaction_session_timeout','30000',true)");
        const result=await work(queries(client));
        await client.query('COMMIT');return result;
      }catch(error){destroy=true;try{await client.query('ROLLBACK');}catch{/* discard connection */}throw error;}
      finally{client.release(destroy||destroyAfterTransaction);}
    },
  };return db;
}

export function neonDatabase(url:string,role?:DatabaseRole) {
  const pool=new Pool({connectionString:validateNeonUrl(url),max:3,connectionTimeoutMillis:15000,idleTimeoutMillis:1000});
  // Never print driver errors: they can contain SQL, private data or credentials.
  pool.on('error',()=>{});
  // Workers do not benefit from retaining a WebSocket between event invocations.
  // Closing after each transaction frees the outbound slot before Telegram fetch.
  return {db:pooledDatabase(pool,role,true),close:()=>pool.end()};
}
