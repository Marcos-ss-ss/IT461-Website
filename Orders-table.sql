USE it461;

CREATE TABLE orders (
id INT AUTO_INCREMENT PRIMARY KEY,
first_name VARCHAR(50),
last_name VARCHAR(50),
phone VARCHAR(15),
service VARCHAR(100),
pickup_date VARCHAR(50),
pickup_time VARCHAR(50),
special_notes TEXT,
status VARCHAR(20) DEFAULT 'Pending'
);
ALTER TABLE orders
ADD COLUMN total_cost DECIMAL(10,2);

ALTER TABLE orders
ADD COLUMN status VARCHAR(20) DEFAULT 'Pending';

Select * FROM orders;