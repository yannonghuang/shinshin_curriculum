module.exports = (sequelize, Sequelize) => {
  const School = sequelize.define(
    "school",
    {
      code: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: false,
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
    },
    {
      tableName: "schools",
      freezeTableName: true,
      // Static seed lookup table (id/code, name only) -- no created_at/
      // updated_at columns, matching role.model.js's same pattern.
      timestamps: false,
    }
  );

  return School;
};
