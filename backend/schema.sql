-- 乡土课程项目实施与案例分享系统（AI智能体）
-- Schema for MySQL, utf8mb4 / utf8mb4_0900_ai_ci throughout.
-- Run manually against a `shinshin_curriculum` database, e.g.:
--   mysql -u root -p -e "CREATE DATABASE shinshin_curriculum CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
--   mysql -u root -p shinshin_curriculum < schema.sql

-- Without this, the session charset used to run this script (whether by
-- docker-entrypoint-initdb.d or a manual `mysql < schema.sql`) falls back to
-- the client's default, which isn't guaranteed to be utf8mb4 -- confirmed on
-- a real deploy: the seed 管理员 chinese_name below landed corrupted
-- (mojibake) without this, even though the target column is utf8mb4.
SET NAMES utf8mb4;

CREATE TABLE roles (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(32) NOT NULL UNIQUE  -- 'admin' | 'teacher' | 'expert'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(64) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  chinese_name VARCHAR(64) NULL,
  phone VARCHAR(32) NULL,
  email_verified TINYINT(1) NOT NULL DEFAULT 0,
  -- Not in the originally-approved plan SQL: added to support the
  -- late-added full auth flow, which mirrors shinshin's auth.controller.js
  -- exactly (signin/signout read + update last_login, signin returns it).
  last_login DATETIME NULL,
  -- Admin user-management: a suspended account can't sign in (checked
  -- between password and email-verification checks) but is not deleted.
  suspended TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE user_roles (
  user_id BIGINT NOT NULL,
  role_id BIGINT NOT NULL,
  PRIMARY KEY (user_id, role_id),
  CONSTRAINT fk_ur_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ur_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE plans (   -- 乡土课程计划
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  teacher_id BIGINT NOT NULL,
  title VARCHAR(255) NOT NULL,
  theme VARCHAR(255) NULL,             -- one of the 11 乡土主题 values, migrated taxonomy
  grade VARCHAR(32) NULL,              -- 一年级..六年级
  year INT NOT NULL,
  planned_lesson_count INT NULL,       -- 预计课时 -> drives lesson tab count
  plan_mode ENUM('upload','online') NOT NULL,
  plan_form_data JSON NULL,            -- structured WHY/WHAT/HOW template answers when plan_mode='online'
  status ENUM('draft','submitted','reviewed') NOT NULL DEFAULT 'draft',
  is_excellent_case TINYINT(1) NOT NULL DEFAULT 0,
  curator_note VARCHAR(1024) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_plans_teacher FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE artifacts (   -- both 课程设计 files and per-课时 实施记录 files
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  plan_id BIGINT NOT NULL,
  lesson_index INT NULL,               -- NULL = plan-level (课程设计文件); 1..N = that lesson's tab
  category VARCHAR(64) NOT NULL,       -- '课程设计文件' | '实施记录文件' | '课件PPT' | '图片' | '视频'
  description VARCHAR(1024) NULL,
  attachment_path VARCHAR(1024) NOT NULL,
  attachment_name VARCHAR(255) NOT NULL,
  attachment_mime VARCHAR(255) NULL,
  attachment_size BIGINT NULL,
  type VARCHAR(64) NOT NULL,           -- lowercased file extension
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_artifacts_plan FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE reviews (   -- 评价乡土课程计划 + 评价乡土课程实施记录, expert or AI
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  plan_id BIGINT NOT NULL,
  lesson_index INT NULL,               -- NULL = review of the whole plan; else that lesson
  reviewer_type ENUM('expert','ai') NOT NULL,
  reviewer_id BIGINT NULL,             -- FK users; NULL when reviewer_type='ai'
  section_key VARCHAR(64) NULL,        -- 'WHY'|'WHAT'|'HOW'|free text; expert-only, AI review targets the whole doc
  score DECIMAL(4,1) NULL,
  content TEXT NOT NULL,
  ai_model VARCHAR(128) NULL,          -- 'qwen3.8-max' when reviewer_type='ai'
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_reviews_plan FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
  CONSTRAINT fk_reviews_reviewer FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_materials (   -- 共享学习材料库
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  material_type ENUM('file','link') NOT NULL,
  attachment_path VARCHAR(1024) NULL,
  attachment_name VARCHAR(255) NULL,
  attachment_mime VARCHAR(255) NULL,
  attachment_size BIGINT NULL,
  external_url VARCHAR(1024) NULL,     -- 视频链接
  theme VARCHAR(255) NULL,
  grade VARCHAR(32) NULL,
  uploaded_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_lm_uploader FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Seed roles. AI智能体 is not a login role — AI-authored reviews are written
-- by the server itself (reviews.reviewer_type='ai', reviewer_id=NULL,
-- ai_model set for audit). No AI user account needed.
INSERT INTO roles (name) VALUES ('admin'), ('teacher'), ('expert');

-- Pre-seeded 管理员 account so a fresh deployment always has at least one
-- admin able to sign in and create further admins via POST /api/auth/admin/users
-- (public signup can never mint an admin account — see verifySignUp.checkNotAdminRole).
-- Password hash below is bcrypt.hashSync('manager', 8) from this app's own
-- bcryptjs — change this password immediately after first login in any real
-- deployment.
INSERT INTO users (username, email, password, chinese_name, email_verified)
VALUES ('manager', 'manager@example.com', '$2a$08$W8d2hCSpmg858uQw9hYLT.ejIzlm9/qjCHI4XFNce8Eil76L5DxP6', '管理员', 1);

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u, roles r WHERE u.username = 'manager' AND r.name = 'admin';
