// Tells the game page it is on the cloud site: phones pair through the /ws room relay, not over Wi-Fi or USB.
module.exports = (req, res) => {
  res.setHeader('cache-control', 'no-store');
  res.json({ app: 'rm-racing-sim', cloud: true });
};
