/* 'use strict';
const { USER_TABLE } = require('../models/userModel');
const { CUSTOMER_TABLE } = require('../models/customerModel');
const { CATEGORY_TABLE } = require('../models/categoryModel');
const { PRODUCT_TABLE } = require('../models/productModel');
const { ORDER_TABLE } = require('../models/orderModel');
const { ORDER_PRODUCT_TABLE } = require('../models/order-productModel');
const { RECYCLER_TABLE } = require('../models/recyclerModel');
const { WASTE_CATEGORY_TABLE } = require('../models/wasteCategoryModel');
const { WASTE_TABLE } = require('../models/wasteModel');
const { PAYMENT_TABLE } = require('../models/paymentModel');
const { PAYMENT_WASTE_TABLE } = require('../models/payment-wasteModel');
const { WALLET_TABLE } = require('../models/walletModel');

const { Sequelize, DataTypes } = require('sequelize');

module.exports = {
  async up (queryInterface, Sequelize) {
 await queryInterface.createTable(USER_TABLE, {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER
  },
  email: {
    allowNull: false,
    type: DataTypes.STRING,
    unique: true,
  },
  password: {
    allowNull: false,
    type: DataTypes.STRING
  },
  recoveryToken: {
    field: 'recovery_token',
    allowNull: true,
    type: DataTypes.STRING
  },
  role: {
    allowNull: false,
    type: DataTypes.STRING,
    defaultValue: 'customer'
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'create_at',
    defaultValue: Sequelize.NOW
  }
});
 await queryInterface.createTable(CUSTOMER_TABLE, {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER
  },
  name: {
    allowNull: false,
    type: DataTypes.STRING,
  },
  lastName: {
    allowNull: false,
    type: DataTypes.STRING,
    field: 'last_name',
  },
  identityNumber: {
    allowNull: true,
    type:DataTypes.INTEGER,
    field: 'identity_number',
  },
  phone: {
    allowNull: true,
    type: DataTypes.STRING,
  },
  phoneTwo: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'phone_two'
  },
  province: {
    allowNull: true,
    type: DataTypes.STRING,
  },
  city: {
    allowNull: true,
    type: DataTypes.STRING
  },
  postalCode: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'postal_code'
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
  userId: {
    field: 'user_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    unique: true,
    references: {
      model: USER_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  }
});
 await queryInterface.createTable(CATEGORY_TABLE, {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER
  },
  name: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false,
  },
  image: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
});
 await queryInterface.createTable(PRODUCT_TABLE, {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  image: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  price: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
  categoryId: {
    field: 'category_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: CATEGORY_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  }
});
 await queryInterface.createTable(ORDER_TABLE, {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER
  },
  customerId: {
    field: 'customer_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: CUSTOMER_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  }});
 await queryInterface.createTable(ORDER_PRODUCT_TABLE, {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
  amount: {
    allowNull: false,
    type: DataTypes.INTEGER
  },
  orderId: {
    field: 'order_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: ORDER_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  },
  productId: {
    field: 'product_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: PRODUCT_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  }
});
 await queryInterface.createTable(RECYCLER_TABLE, {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER,
  },
  name: {
    allowNull: false,
    type: DataTypes.STRING,
  },
  lastName: {
    allowNull: false,
    type: DataTypes.STRING,
    field: 'last_name',
  },
  identityNumber: {
    allowNull: true,
    type: DataTypes.INTEGER,
    field: 'identity_number',
  },
  phone: {
    allowNull: true,
    type: DataTypes.STRING,
  },
  phoneTwo: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'phone_two',
  },
  province: {
    allowNull: true,
    type: DataTypes.STRING,
  },
  city: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'city',
  },
  postalCode: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'postal_code',
  },
  paymentType: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'payment_type'       
  },
  bank: {
    allowNull: true,
    type: DataTypes.STRING,
  },
  typeCount: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'type_count',
  },
  countNumber: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'count_number',
  },
  paymentDate: {
    allowNull: true,
    type: DataTypes.DATE,
    field: 'payment_date',
  },
  stateOfThePayment: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'state_of_the_payment',
    defaultValue: 'revision',
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
  userId: {
    field: 'user_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    unique: true,
    references: {
      model: USER_TABLE,
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
});
 await queryInterface.createTable(WASTE_CATEGORY_TABLE, {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER
  },
  name: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false,
  },
  image: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
});
 await queryInterface.createTable(WASTE_TABLE, {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  image: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  price: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
  wasteCategoryId: {
    field: 'waste_category_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: WASTE_CATEGORY_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  }
});
 await queryInterface.createTable(PAYMENT_TABLE, {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER
  },
  recyclerId: {
    field: 'recycler_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: RECYCLER_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  }});
 await queryInterface.createTable(PAYMENT_WASTE_TABLE, {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
  amount: {
    allowNull: false,
    type: DataTypes.INTEGER
  },
  paymentId: {
    field: 'payment_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: PAYMENT_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  },
  wasteId: {
    field: 'waste_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: WASTE_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  }
});
 await queryInterface.createTable(WALLET_TABLE, {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER,
  },
  recyclerId: {
    field: 'recycler_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    unique: true,
    references: {
      model: RECYCLER_TABLE,
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
  credit: {
    allowNull: true,
    type: DataTypes.INTEGER,
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'create_at',
    defaultValue: Sequelize.NOW,
  },
});
  },

  async down (queryInterface, Sequelize) {
   await queryInterface.dropTable(USER_TABLE);
   await queryInterface.dropTable(CUSTOMER_TABLE);
   await queryInterface.dropTable(CATEGORY_TABLE);
   await queryInterface.dropTable(PRODUCT_TABLE);
   await queryInterface.dropTable(ORDER_TABLE);
   await queryInterface.dropTable(ORDER_PRODUCT_TABLE);
   await queryInterface.dropTable(RECYCLER_TABLE);
   await queryInterface.dropTable(WASTE_CATEGORY_TABLE);
   await queryInterface.dropTable(WASTE_TABLE);
   await queryInterface.dropTable(PAYMENT_TABLE);
   await queryInterface.dropTable(PAYMENT_WASTE_TABLE);
   await queryInterface.dropTable(WALLET_TABLE);
  }
};
 */