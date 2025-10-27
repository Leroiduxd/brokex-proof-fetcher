module.exports = {
  apps: [
    {
      name: "brokex-proof-ingestor",
      script: "./index.js",
      env: {
        NODE_ENV: "production"
      },
      max_restarts: 20,
      restart_delay: 2000,
      time: true
    }
  ]
};
