module.exports = (sequelize, Sequelize) => {
  const Review = sequelize.define(
    "review",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      planId: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      lessonIndex: {
        type: Sequelize.INTEGER, // NULL = review of the whole plan; else that lesson
      },
      // 'admin' is a manager submitting a review through the same form an
      // expert uses (route-gated as isExpertOrAdmin -- see review.routes.js)
      // -- distinguished from 'expert' so the UI can badge/label them
      // differently even though both are human-authored, scored reviews
      // with a real reviewerId (see review.controller.js#create).
      reviewerType: {
        type: Sequelize.ENUM("expert", "ai", "admin"),
        allowNull: false,
      },
      reviewerId: {
        type: Sequelize.BIGINT, // FK users; NULL when reviewerType='ai'
      },
      sectionKey: {
        // Free text, no DB-level enum -- convention driven entirely by the
        // frontend (review-list.component.js) and review.controller.js:
        //   'WHY'|'WHAT'|'HOW'            -- 设计's top-level segments, lessonIndex=null
        //   'LESSON_DESIGN'                -- 设计/分课时设计/课时N, paired with lessonIndex=N
        //   'EXECUTION_RECORD'             -- 实施/课时N/实施记录, paired with lessonIndex=N
        //   'IMPLEMENTATION_OVERALL'       -- 实施/整体点评's own comments/AI review, lessonIndex=null
        //   null                           -- 设计/整体点评's own comments/AI review, lessonIndex=null
        type: Sequelize.STRING(64),
      },
      score: {
        type: Sequelize.DECIMAL(4, 1),
      },
      content: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      aiModel: {
        type: Sequelize.STRING(128), // e.g. 'qwen3.8-max' when reviewerType='ai'
      },
      // Snapshot of plans.content_version_at at the moment this review was
      // created -- see plan.model.js's contentVersionAt comment. Two reviews
      // with the same value were written between the same two consecutive
      // content edits ("thread"); once the plan's contentVersionAt moves
      // past this value, the review is superseded (see review.controller.js
      // #delete, which locks a superseded review against deletion).
      planVersionAt: {
        type: Sequelize.DATE,
      },
      // Snapshot of plans.segment_version_at[<this review's segment>] at the
      // moment this review was created -- see plan.model.js's
      // segmentVersionAt comment. NULL when the review's sectionKey/
      // lessonIndex don't resolve to a trackable segment (e.g. IMPLEMENTATION_
      // OVERALL, or a plain 整体 comment with no sectionKey) -- those fall
      // back to the plan-wide planVersionAt comparison only. Once the plan's
      // segmentVersionAt entry for this segment moves past this snapshot,
      // the segment itself (not just the plan as a whole) was edited after
      // this review -- see review-list.component.js.
      segmentVersionAt: {
        type: Sequelize.DATE,
      },
      // The AI 点评标准 version an AI review was written against (see
      // services/aiPlanReview.js) -- NULL for expert/admin reviews and for
      // AI reviews from before reviews followed the standard (or written
      // while none existed). Bulk AI 点评 treats a review on an older
      // version as out of date.
      standardId: {
        type: Sequelize.BIGINT,
      },
      // When the plan's own teacher first saw this review in one of the two
      // 整体点评 views (see review.controller.js#markSeen). NULL = not seen
      // yet, which flashes that view's sidebar leaf in the teacher's
      // plan-detail page. An AI review the teacher requested themselves is
      // created already seen; expert reviews and the admin's bulk AI 点评
      // start unseen.
      teacherSeenAt: {
        type: Sequelize.DATE,
      },
    },
    {
      tableName: "reviews",
      freezeTableName: true,
    }
  );

  return Review;
};
