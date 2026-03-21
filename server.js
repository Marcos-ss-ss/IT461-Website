const express = require("express");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();

/* Middleware */

app.use(bodyParser.json());
app.use(express.static(__dirname));

/* Database Connection */

const db = mysql.createConnection({
host: "localhost",
user: "root",
password: "Marcosmaia2004!",
database: "it461"
});

db.connect(err => {
if(err){
console.log("Database connection failed");
throw err;
}
console.log("Connected to database");
});


/* ============================= */
/* CREATE ACCOUNT (CUSTOMERS) */
/* ============================= */

app.post("/createAccount",(req,res)=>{

const { firstName, lastName, phone, email, password } = req.body;

/* Check if phone already exists */

const checkSQL = "SELECT * FROM users WHERE phone=?";

db.query(checkSQL,[phone],(err,result)=>{

if(err){
console.log(err);
res.json({success:false,message:"Server error"});
return;
}

if(result.length > 0){

res.json({
success:false,
message:"Phone number already registered"
});

return;

}

/* Insert new customer */

const insertSQL = `
INSERT INTO users
(first_name,last_name,phone,email,password,role)
VALUES (?,?,?,?,?,'customer')
`;

db.query(insertSQL,[firstName,lastName,phone,email,password],(err,result)=>{

if(err){
console.log(err);
res.json({success:false,message:"Account creation failed"});
return;
}

res.json({
success:true,
message:"Account created successfully"
});

});

});

});


/* ============================= */
/* LOGIN ROUTE */
/* ============================= */

app.post("/login",(req,res)=>{

const {login,password} = req.body;


/* WORKER LOGIN */

if(login === "washingwds@gmail.com"){

const sql = `
SELECT * FROM users 
WHERE email=? AND password=? AND role='worker'
`;

db.query(sql,[login,password],(err,result)=>{

if(err){
console.log(err);
res.json({success:false});
return;
}

if(result.length > 0){

res.json({
success:true,
role:"worker"
});

}
else{

res.json({success:false});

}

});

return;

}


/* CUSTOMER LOGIN (PHONE) */

const sql = `
SELECT * FROM users 
WHERE phone=? AND password=? AND role='customer'
`;

db.query(sql,[login,password],(err,result)=>{

if(err){
console.log(err);
res.json({success:false});
return;
}

if(result.length > 0){

res.json({
success:true,
role:"customer"
});

}
else{

res.json({success:false});

}

});

});


/* ============================= */
/* CREATE ORDER */
/* ============================= */

app.post("/createOrder",(req,res)=>{

const {
firstName,
lastName,
phone,
service,
notes,
items,
totalCost
} = req.body;

const sql = `
INSERT INTO orders
(first_name,last_name,phone,service,special_notes,total_cost)
VALUES (?,?,?,?,?,?)
`;

db.query(sql,
[firstName,lastName,phone,service,notes,totalCost],
(err,result)=>{

if(err){
console.log(err);
res.json({success:false});
return;
}

res.json({success:true});

});

});


/* ============================= */
/* GET ORDERS (WORKER PAGE) */
/* ============================= */

app.get("/getOrders",(req,res)=>{

const sql = "SELECT * FROM orders ORDER BY id DESC";

db.query(sql,(err,result)=>{

if(err){
console.log(err);
res.json([]);
return;
}

res.json(result);

});

});


/* ============================= */
/* COMPLETE ORDER */
/* ============================= */

app.post("/completeOrder",(req,res)=>{

const {orderId} = req.body;

const sql = "UPDATE orders SET status='Completed' WHERE id=?";

db.query(sql,[orderId],(err,result)=>{

if(err){
console.log(err);
res.json({success:false});
return;
}

res.json({success:true});

});

});


/* ============================= */
/* START SERVER */
/* ============================= */

app.listen(3000,()=>{
console.log("Server running on http://localhost:3000");
});