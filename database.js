const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, 'betweena.db.json');
let dbInstance = null;

class JsonDB {
  constructor() { this.data = this._load(); }
  _load() {
    if (fs.existsSync(DB_PATH)) { try { return JSON.parse(fs.readFileSync(DB_PATH,'utf8')); } catch(e){} }
    return { users:[], wallets:[], wallet_transactions:[], transactions:[], transaction_messages:[], notifications:[] };
  }
  _save() { fs.writeFileSync(DB_PATH, JSON.stringify(this.data)); }
  pragma(){}
  exec(){}
  prepare(sql) { return new Stmt(this, sql.trim()); }
}

class Stmt {
  constructor(db, sql){ this.db=db; this.sql=sql; }
  run(...a){
    const p=a.flat(), s=this.sql, d=this.db.data, now=new Date().toISOString();
    if(/^INSERT INTO users/i.test(s)){
      const [id,fn,ln,email,phone,ph,kyc]=p;
      d.users.push({id,first_name:fn,last_name:ln,email,phone,password_hash:ph,kyc_status:kyc,role:'user',created_at:now,updated_at:now});
    } else if(/^INSERT INTO wallets/i.test(s)){
      const [id,uid,bal]=p; d.wallets.push({id,user_id:uid,balance:parseFloat(bal)||0,currency:'USD',created_at:now});
    } else if(/^INSERT INTO wallet_transactions/i.test(s)){
      const [id,wid,type,amt,desc,ref,baf]=p; d.wallet_transactions.push({id,wallet_id:wid,type,amount:parseFloat(amt),description:desc,reference:ref,balance_after:parseFloat(baf),created_at:now});
    } else if(/^INSERT INTO transactions/i.test(s)){
      const cols=s.match(/\(([^)]+)\)/)?.[1]?.split(',').map(c=>c.trim())||[];
      const obj={currency:'USD',created_at:now,updated_at:now}; cols.forEach((c,i)=>{obj[c]=p[i]!==undefined?p[i]:null;}); d.transactions.push(obj);
    } else if(/^INSERT INTO transaction_messages/i.test(s)){
      const [id,tid,sid,msg]=p; d.transaction_messages.push({id,transaction_id:tid,sender_id:sid,message:msg,type:'chat',created_at:now});
    } else if(/^INSERT INTO notifications/i.test(s)){
      const [id,uid,title,msg,type,txid]=p; d.notifications.push({id,user_id:uid,title,message:msg,type:type||'info',transaction_id:txid||null,read:0,created_at:now});
    } else if(/^UPDATE users SET first_name/i.test(s)){
      const [fn,ln,phone,id]=p; const u=d.users.find(u=>u.id===id); if(u){u.first_name=fn;u.last_name=ln;u.phone=phone;u.updated_at=now;}
    } else if(/^UPDATE wallets/i.test(s)){
      const [bal,id]=p; const w=d.wallets.find(w=>w.id===id); if(w) w.balance=parseFloat(bal);
    } else if(/^UPDATE transactions SET counterparty_id/i.test(s)){
      const [cid,status,id]=p; const t=d.transactions.find(t=>t.id===id); if(t){t.counterparty_id=cid;t.status=status;t.updated_at=now;}
    } else if(/^UPDATE transactions SET status = \?, funded_at/i.test(s)){
      const [status,id]=p; const t=d.transactions.find(t=>t.id===id); if(t){t.status=status;t.funded_at=now;t.updated_at=now;}
    } else if(/^UPDATE transactions SET status = \?, shipped_at/i.test(s)){
      const [status,track,id]=p; const t=d.transactions.find(t=>t.id===id); if(t){t.status=status;t.shipped_at=now;t.tracking_info=track;t.updated_at=now;}
    } else if(/^UPDATE transactions SET status = \?, approved_at/i.test(s)){
      const [status,id]=p; const t=d.transactions.find(t=>t.id===id); if(t){t.status=status;t.approved_at=now;t.completed_at=now;t.updated_at=now;}
    } else if(/^UPDATE transactions SET status = \?, disputed_at/i.test(s)){
      const [status,reason,id]=p; const t=d.transactions.find(t=>t.id===id); if(t){t.status=status;t.disputed_at=now;t.dispute_reason=reason;t.updated_at=now;}
    } else if(/^UPDATE transactions SET status = \?, cancelled_at/i.test(s)){
      const [status,id]=p; const t=d.transactions.find(t=>t.id===id); if(t){t.status=status;t.cancelled_at=now;t.updated_at=now;}
    } else if(/^UPDATE notifications SET read/i.test(s)){
      const [uid]=p; d.notifications.filter(n=>n.user_id===uid).forEach(n=>n.read=1);
    }
    this.db._save(); return {changes:1};
  }
  get(...a){
    const p=a.flat(), s=this.sql, d=this.db.data;
    if(/FROM users WHERE email/i.test(s)) return {...(d.users.find(u=>u.email===p[0])||{})};
    if(/FROM users WHERE id/i.test(s)){
      const u=d.users.find(u=>u.id===p[0]); if(!u) return undefined;
      if(!/password/.test(s)) return {id:u.id,first_name:u.first_name,last_name:u.last_name,email:u.email,phone:u.phone,kyc_status:u.kyc_status,created_at:u.created_at};
      return {...u};
    }
    if(/FROM wallets WHERE user_id/i.test(s)) return d.wallets.find(w=>w.user_id===p[0]);
    if(/FROM wallets WHERE id/i.test(s)) return d.wallets.find(w=>w.id===p[0]);
    if(/FROM transactions WHERE id/i.test(s)) return d.transactions.find(t=>t.id===p[0]);
    if(/FROM transactions WHERE join_code/i.test(s)) return d.transactions.find(t=>t.join_code===p[0]);
    if(/COUNT.*notifications.*read\s*=\s*0/i.test(s)) return {count:d.notifications.filter(n=>n.user_id===p[0]&&n.read===0).length};
    return undefined;
  }
  all(...a){
    const p=a.flat(), s=this.sql, d=this.db.data;
    if(/FROM transactions.*initiator_id.*counterparty_id/i.test(s)){
      const uid=p[0]; return d.transactions.filter(t=>t.initiator_id===uid||t.counterparty_id===uid).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
    }
    if(/FROM wallet_transactions WHERE wallet_id/i.test(s)){
      return d.wallet_transactions.filter(w=>w.wallet_id===p[0]).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,20);
    }
    if(/FROM transaction_messages/i.test(s)){
      return d.transaction_messages.filter(m=>m.transaction_id===p[0]).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at))
        .map(m=>{const u=d.users.find(u=>u.id===m.sender_id);return{...m,first_name:u?.first_name||'',last_name:u?.last_name||''};});
    }
    if(/FROM notifications WHERE user_id/i.test(s)){
      return d.notifications.filter(n=>n.user_id===p[0]).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,30);
    }
    return [];
  }
}

function getDb(){ if(!dbInstance) dbInstance=new JsonDB(); return dbInstance; }

function initDb(){
  const db=getDb();
  if(db.data.users.length===0){
    const hash=bcrypt.hashSync('demo1234',10);
    const did=uuidv4(), sid=uuidv4();
    db.prepare('INSERT INTO users (id,first_name,last_name,email,phone,password_hash,kyc_status) VALUES (?,?,?,?,?,?,?)').run(did,'Kwame','Asante','demo@betweena.com','+233201234567',hash,'verified');
    db.prepare('INSERT INTO wallets (id,user_id,balance) VALUES (?,?,?)').run(uuidv4(),did,2500.00);
    db.prepare('INSERT INTO users (id,first_name,last_name,email,phone,password_hash,kyc_status) VALUES (?,?,?,?,?,?,?)').run(sid,'Ama','Darko','seller@betweena.com','+233209876543',hash,'verified');
    db.prepare('INSERT INTO wallets (id,user_id,balance) VALUES (?,?,?)').run(uuidv4(),sid,800.00);
    const seeds=[
      {title:'iPhone 15 Pro — Private Sale',amount:850,status:'funded',counter:sid,role:'buyer',cat:'electronics'},
      {title:'Logo Design — Freelance Project',amount:320,status:'completed',counter:sid,role:'buyer',cat:'services'},
      {title:'Toyota Camry 2019 — Vehicle',amount:7200,status:'disputed',counter:sid,role:'buyer',cat:'vehicles'},
      {title:'Bulk Fabric Order (500kg)',amount:3100,status:'awaiting_counterparty',counter:null,role:'buyer',cat:'goods'},
    ];
    for(const s of seeds){
      const tid=uuidv4(), jc=Math.random().toString(36).substr(2,8).toUpperCase(), fee=s.amount*0.0225;
      const now=new Date().toISOString();
      const ago=(n)=>new Date(Date.now()-864e5*n).toISOString();
      db.data.transactions.push({id:tid,title:s.title,description:'',amount:s.amount,currency:'USD',category:s.cat,initiator_id:did,initiator_role:s.role,counterparty_id:s.counter||null,counterparty_email:null,join_code:jc,status:s.status,fee_amount:fee,fee_rate:0.0225,inspection_days:3,notes:'',tracking_info:'',funded_at:['funded','completed','disputed'].includes(s.status)?ago(3):null,shipped_at:null,delivered_at:null,approved_at:null,disputed_at:s.status==='disputed'?ago(2):null,completed_at:s.status==='completed'?ago(1):null,cancelled_at:null,dispute_reason:s.status==='disputed'?'Goods not as described':null,dispute_resolution:null,created_at:ago(5),updated_at:now});
    }
    db.prepare('INSERT INTO notifications (id,user_id,title,message,type,transaction_id) VALUES (?,?,?,?,?,?)').run(uuidv4(),did,'Welcome to Betweena!','Your account is set up. Add funds and start your first secure transaction.','success',null);
    db._save();
    console.log('✅ Seeded. Login: demo@betweena.com / demo1234');
  }
  return db;
}

module.exports={getDb,initDb};
