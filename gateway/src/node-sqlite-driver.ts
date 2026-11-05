/** The node-local indexes retain their SQLite format across packaged Node and external native drivers. */
import { createRequire } from 'node:module'

type Bind = string|number|null|bigint|Uint8Array
interface Statement {get(...values:Bind[]):unknown;all(...values:Bind[]):unknown[];run(...values:Bind[]):{changes:number|bigint}}
/** Synchronous operations shared by the built-in and installed SQLite drivers. */
export interface NodeSqlite {prepare(sql:string):Statement;exec(sql:string):unknown;close():void}

/** @param path - verified existing file. @returns the platform's SQLite driver for that one file. */
export function openNodeSqlite(path:string):NodeSqlite{
  const native=process.getBuiltinModule?.('node:sqlite') as {DatabaseSync:new(file:string)=>NodeSqlite}|undefined
  if(native)return new native.DatabaseSync(path)
  const legacy=createRequire(import.meta.url)('better-sqlite3') as new(file:string,options:{fileMustExist:true})=>NodeSqlite
  return new legacy(path,{fileMustExist:true})
}

/** @param db - one private file handle. @param write - reserve the writer before inspecting application revisions.
 * @param work - synchronous transaction. @returns an atomic operation that preserves the prior state on failure.
 */
export function sqliteOperation<A extends unknown[],R>(db:NodeSqlite,write:boolean,work:(...args:A)=>R):(...args:A)=>R{
  return (...args)=>{
    db.exec(write?'BEGIN IMMEDIATE':'BEGIN')
    try {const result=work(...args);db.exec('COMMIT');return result}
    catch(error){try{db.exec('ROLLBACK')}catch(rollback){throw new AggregateError([error,rollback],'The node database transaction failed.')};throw error}
  }
}
