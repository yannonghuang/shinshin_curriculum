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
  -- Only meaningful for 教师 -- enforced at the application layer (see
  -- auth.controller.js's validateSchoolFields), not a DB constraint, since a
  -- role is a many-to-many relation (user_roles) that a CHECK constraint
  -- can't reach. Migrated from shinshin's `schools` table (code, name) via
  -- react-app/src/constants/school-options.js's static SCHOOLS list.
  school_code INT NULL,
  school_name VARCHAR(255) NULL,
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

CREATE TABLE template_versions (   -- runtime-editable field schemas driving the online-fill forms
                                    -- (WHY/WHAT/HOW-equivalent + 实施记录-equivalent) and their
                                    -- on-the-fly .docx generation/upload-extraction -- see
                                    -- templateVersion.model.js and services/templateParser.js.
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  template_key VARCHAR(64) NOT NULL,   -- 'plan_design' | 'lesson_execution' today; any string later
  version INT NOT NULL,                -- 1, 2, 3... per template_key
  schema_json JSON NOT NULL,           -- { sections: [ { key, label, fields: [ { key, label, group } ] } ] }
  source_file_path VARCHAR(1024) NULL, -- uploaded reference .docx; NULL for the hand-authored seed versions below
  source_file_name VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 0,  -- exactly one active row per template_key
  created_by BIGINT NULL,              -- admin who uploaded it; NULL for the seed
  notes TEXT NULL,                     -- free-text admin note, e.g. why this version was published/rolled back to
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_template_versions_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT uq_template_versions_key_version UNIQUE (template_key, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE plans (   -- 乡土课程计划
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  teacher_id BIGINT NOT NULL,
  title VARCHAR(255) NOT NULL,
  theme VARCHAR(255) NULL,             -- one of the 11 乡土主题 values, migrated taxonomy
  grade VARCHAR(32) NULL,              -- 一年级..六年级
  year INT NOT NULL,
  season ENUM('秋季','春季') NULL,      -- 学期 -- nullable (pre-existing rows), new plans always get one client-side
  planned_lesson_count INT NULL,       -- 预计课时 -> drives lesson tab count
  plan_mode ENUM('upload','online') NOT NULL,
  plan_form_data JSON NULL,            -- structured WHY/WHAT/HOW template answers when plan_mode='online'
  execution_form_data JSON NULL,       -- structured per-课时 实施记录 template answers, keyed by lesson index (see plan.model.js)
  plan_template_version_id BIGINT NULL,      -- template_versions row this plan's WHY/WHAT/HOW-equivalent form is pinned to, stamped at creation
  execution_template_version_id BIGINT NULL, -- template_versions row this plan's 实施记录-equivalent form is pinned to, stamped at creation
  status ENUM('draft','submitted','reviewed') NOT NULL DEFAULT 'draft',
  is_excellent_case TINYINT(1) NOT NULL DEFAULT 0,
  curator_note VARCHAR(1024) NULL,
  suspended TINYINT(1) NOT NULL DEFAULT 0,  -- admin-only stop; hidden from public/other-teacher views, still visible read-only to the owning teacher and fully to admin
  content_version_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- bumped only by actual content edits, not curatorNote/isExcellentCase/suspend -- see plan.model.js
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_plans_teacher FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_plans_plan_template FOREIGN KEY (plan_template_version_id) REFERENCES template_versions(id) ON DELETE SET NULL,
  CONSTRAINT fk_plans_execution_template FOREIGN KEY (execution_template_version_id) REFERENCES template_versions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE folders (   -- user-created folders, scoped to one 课时's 实施记录 file space
                          -- (mini-cloud-file-system view -- see plan-detail.component.js's
                          -- lesson-file-manager.component.js); never plan-level, no folders
                          -- under 课程设计文件.
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  plan_id BIGINT NOT NULL,
  lesson_index INT NOT NULL,
  parent_folder_id BIGINT NULL,        -- NULL = root of that 课时's file space
  name VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_folders_plan FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
  CONSTRAINT fk_folders_parent FOREIGN KEY (parent_folder_id) REFERENCES folders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE artifacts (   -- both 课程设计 files and per-课时 实施记录 files
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  plan_id BIGINT NOT NULL,
  lesson_index INT NULL,               -- NULL = plan-level (课程设计文件); 1..N = that lesson's tab
  folder_id BIGINT NULL,               -- NULL = root of that 课时's file space; only meaningful
                                        -- when lesson_index IS NOT NULL (see folders table)
  category VARCHAR(64) NOT NULL,       -- '课程设计文件' | '实施记录文件' | '课件PPT' | '图片' | '视频'
  description VARCHAR(1024) NULL,
  attachment_path VARCHAR(1024) NOT NULL,
  attachment_name VARCHAR(255) NOT NULL,
  attachment_mime VARCHAR(255) NULL,
  attachment_size BIGINT NULL,
  type VARCHAR(64) NOT NULL,           -- lowercased file extension
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_artifacts_plan FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
  CONSTRAINT fk_artifacts_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL
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
  plan_version_at DATETIME NULL,       -- snapshot of plans.content_version_at at creation -- see review.model.js
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

-- Seed template_versions v1 for both template_key values, hand-authored to
-- exactly match the structure that used to be hard-coded in
-- plan-options.js/planDocGenerator.js/lessonExecutionDocGenerator.js (now
-- deleted) -- so every existing plan's plan_form_data/execution_form_data
-- JSON keeps rendering identically once plans.plan_template_version_id/
-- execution_template_version_id are backfilled to these ids (see
-- ALIYUN_DEPLOY.md-style manual-migration note for already-initialized DBs;
-- a fresh install picks these up automatically via this seed + the
-- plan.controller.js#create stamp).
INSERT INTO template_versions (template_key, version, schema_json, is_active)
VALUES (
  'plan_design', 1,
  '{"sections":[
    {"key":"why","label":"WHY · 学习目标","fields":[
      {"key":"cognitiveGoals","label":"认知思维目标","group":null},
      {"key":"practicalGoals","label":"实践技能目标","group":null},
      {"key":"socialEmotionalGoals","label":"社会情感目标","group":null},
      {"key":"otherGoals","label":"其他目标","group":null}
    ]},
    {"key":"what","label":"WHAT · 项目简介","fields":[
      {"key":"projectIntro","label":"项目介绍","group":null},
      {"key":"drivingQuestion","label":"驱动问题","group":null},
      {"key":"finalOutcomePersonal","label":"个人成果","group":"最终成果"},
      {"key":"finalOutcomeTeam","label":"团队成果","group":"最终成果"},
      {"key":"publicDisplayMethod","label":"公开展示方式","group":null}
    ]},
    {"key":"how","label":"HOW · 活动设计","fields":[
      {"key":"entryActivity","label":"入项活动","group":"一、入项（1-2课时）"},
      {"key":"teacherStudentDiscussion","label":"师生共议驱动问题","group":"一、入项（1-2课时）"},
      {"key":"outcomeDisplayDiscussion","label":"讨论最终成果及展示","group":"一、入项（1-2课时）"},
      {"key":"requirementsChecklist","label":"讨论须知清单","group":"一、入项（1-2课时）"},
      {"key":"knowledgeExploration","label":"知识探究","group":"探究与制作（4课时以上）"},
      {"key":"productMaking","label":"产品制作","group":"探究与制作（4课时以上）"},
      {"key":"reflectionIteration","label":"反思与迭代","group":"探究与制作（4课时以上）"},
      {"key":"finalOutcomeDisplay","label":"最终成果展示","group":"三、出项（1-2课时）"},
      {"key":"reflectionSummary","label":"复盘反思","group":"三、出项（1-2课时）"},
      {"key":"materialsNeeded","label":"需要的材料","group":null},
      {"key":"resourcesNeeded","label":"需要链接的资源","group":null}
    ]}
  ]}',
  1
);

INSERT INTO template_versions (template_key, version, schema_json, is_active)
VALUES (
  'lesson_execution', 1,
  '{"sections":[
    {"key":"record","label":"实施记录","fields":[
      {"key":"lessonGoals","label":"本课时目标","group":null},
      {"key":"materialsPreparation","label":"所需材料及准备","group":null},
      {"key":"evidenceToCollect","label":"需要收集的学习证据","group":null},
      {"key":"teacherActions","label":"教师做了什么","group":"教学活动流程"},
      {"key":"studentActions","label":"学生做了什么","group":"教学活动流程"},
      {"key":"processOutcomes","label":"过程和成果","group":"教学活动流程"},
      {"key":"observationReflection","label":"观察和反思","group":"教学活动流程"}
    ]}
  ]}',
  1
);

-- Every existing plan (there are none on a fresh install, but this keeps
-- schema.sql idempotent-in-spirit with the manual migration run against an
-- already-initialized DB) pins to these two seed versions.
UPDATE plans p
JOIN template_versions pdv ON pdv.template_key = 'plan_design' AND pdv.version = 1
JOIN template_versions lev ON lev.template_key = 'lesson_execution' AND lev.version = 1
SET p.plan_template_version_id = pdv.id, p.execution_template_version_id = lev.id
WHERE p.plan_template_version_id IS NULL OR p.execution_template_version_id IS NULL;
