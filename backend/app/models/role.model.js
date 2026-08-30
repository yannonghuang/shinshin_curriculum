module.exports = (sequelize, Sequelize) => {
  const Role = sequelize.define(
    "role",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      name: {
        type: Sequelize.STRING(32),
        allowNull: false,
        unique: true, // 'admin' | 'teacher' | 'expert'
      },
    },
    {
      tableName: "roles",
      freezeTableName: true,
      // schema.sql's `roles` table is a static seed lookup (id, name only) —
      // no created_at/updated_at columns, so Sequelize's default timestamps
      // must be disabled or every query 500s with "Unknown column 'created_at'".
      timestamps: false,
    }
  );

  return Role;
};
