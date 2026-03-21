CREATE TABLE users (
id INT AUTO_INCREMENT PRIMARY KEY,
first_name VARCHAR(50),
last_name VARCHAR(50),
phone VARCHAR(15),
email VARCHAR(100),
password VARCHAR(255),
role ENUM('customer','worker')
);

INSERT INTO users (first_name,last_name,phone,email,password,role)
VALUES
('John','Doe','6175551234',NULL,'12345','customer'),
('Worker','Admin',NULL,'washingwds@gmail.com','admin123','worker');

SELECT * FROM users;

