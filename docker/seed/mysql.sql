CREATE TABLE authors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  bio TEXT NULL,
  settings JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE posts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  author_id INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  body MEDIUMTEXT,
  published TINYINT(1) NOT NULL DEFAULT 0,
  views INT UNSIGNED NOT NULL DEFAULT 0,
  published_at DATETIME NULL,
  CONSTRAINT fk_posts_author FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE CASCADE,
  INDEX idx_posts_published (published, published_at)
) ENGINE=InnoDB;

INSERT INTO authors (name, email, bio, settings) VALUES
 ('Ada Lovelace', 'ada@example.com', 'First programmer.', JSON_OBJECT('theme','dark','notify',true)),
 ('Alan Turing', 'alan@example.com', NULL, JSON_OBJECT('theme','light')),
 ('Grace Hopper', 'grace@example.com', 'COBOL, compilers.', NULL),
 ('Edsger Dijkstra', 'edsger@example.com', 'Goto considered harmful.', JSON_OBJECT('notify',false));

INSERT INTO posts (author_id, title, body, published, views, published_at)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 300)
SELECT 1 + n % 4, CONCAT('Post number ', n), REPEAT('Lorem ipsum dolor sit amet. ', 1 + n % 6),
       n % 3 <> 0, n * 37 % 10000, IF(n % 3 <> 0, NOW() - INTERVAL n HOUR, NULL)
FROM seq;

CREATE VIEW published_posts AS SELECT id, title, views FROM posts WHERE published = 1;
