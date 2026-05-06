// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract LitVMTriviaGame {
    uint256 public constant MIN_ENTRY_FEE = 1e18; // 1 zkLTC (18 decimals)
    uint256 public constant PLATFORM_BPS = 250;
    uint256 public constant CREATOR_BPS = 250;

    address public platform;
    uint256 public gameCounter;
    uint256 public totalPaidOut;

    enum GameStatus { Open, Ended, Cancelled }
    enum Difficulty { Any, Easy, Medium, Hard }

    struct Game {
        uint256 id;
        string name;
        address creator;
        uint8 categoryId;
        string categoryName;
        Difficulty difficulty;
        uint256 entryFee;
        uint256 maxPlayers;
        uint256 prizePool;
        uint256 registrationEnd;
        uint256 playDeadline;
        address[3] topPlayers;
        bool prizeClaimed;
        GameStatus status;
        address[] players;
        uint256 finishedCount;
    }

    mapping(uint256 => Game) public games;
    mapping(uint256 => mapping(address => uint256)) public scores;
    mapping(address => uint256) public nonces;
    mapping(uint256 => mapping(address => bool)) public hasSubmitted;
    address public verifier;
    mapping(uint256 => mapping(address => bool)) public hasJoined;
    mapping(uint256 => mapping(address => bool)) public hasFinished;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;
    mapping(address => uint256) public gamesPlayed;
    mapping(address => uint256) public gamesWon;
    mapping(address => uint256) public totalEarned;

    event GameCreated(uint256 indexed id, address indexed creator, string name, uint8 categoryId, string categoryName, uint256 entryFee, uint256 maxPlayers, uint256 registrationEnd, uint256 playDeadline);
    event PlayerJoined(uint256 indexed id, address indexed player, uint256 prizePool, uint256 playerCount);
    event ScoreSubmitted(uint256 indexed id, address indexed player, uint256 score);
    event GameEnded(uint256 indexed id, address first, address second, address third);
    event PrizeClaimed(uint256 indexed id, address indexed player, uint256 amount, uint8 position);
    event GameCancelled(uint256 indexed id, string reason);
    event RefundIssued(uint256 indexed id, address indexed player, uint256 amount);

    modifier gameExists(uint256 id) {
        require(id > 0 && id <= gameCounter, "Game not found");
        _;
    }

    constructor(address _verifier) {
        platform = msg.sender;
        verifier = _verifier;
    }

    function createGame(
        string calldata name,
        uint8 categoryId,
        string calldata categoryName,
        uint8 difficulty,
        uint256 entryFee,
        uint256 maxPlayers,
        uint256 registrationSecs,
        uint256 playDeadlineSecs
    ) external returns (uint256) {
        require(bytes(name).length > 0, "Name empty");
        require(entryFee >= MIN_ENTRY_FEE, "Min entry 1 zkLTC");
        require(maxPlayers >= 1 && maxPlayers <= 100, "1-100 players");
        require(registrationSecs >= 60, "Min 60s registration");
        require(playDeadlineSecs >= 60 && playDeadlineSecs <= 86400, "60s-24h play window");
        require(difficulty <= 3, "Bad difficulty");

        gameCounter++;
        uint256 newId = gameCounter;
        Game storage g = games[newId];
        g.id = newId;
        g.name = name;
        g.creator = msg.sender;
        g.categoryId = categoryId;
        g.categoryName = categoryName;
        g.difficulty = Difficulty(difficulty);
        g.entryFee = entryFee;
        g.maxPlayers = maxPlayers;
        g.registrationEnd = block.timestamp + registrationSecs;
        g.playDeadline = block.timestamp + registrationSecs + playDeadlineSecs;
        g.status = GameStatus.Open;

        emit GameCreated(newId, msg.sender, name, categoryId, categoryName, entryFee, maxPlayers, g.registrationEnd, g.playDeadline);
        return newId;
    }

    // ✅ payable — user sends zkLTC as native token
    function joinGame(uint256 id) external payable gameExists(id) {
        Game storage g = games[id];
        require(g.status == GameStatus.Open, "Game not open");
        require(block.timestamp < g.registrationEnd, "Registration closed");
        require(!hasJoined[id][msg.sender], "Already joined");
        require(g.players.length < g.maxPlayers, "Room full");
        require(msg.value == g.entryFee, "Wrong zkLTC amount");

        g.prizePool += msg.value;
        hasJoined[id][msg.sender] = true;
        g.players.push(msg.sender);
        gamesPlayed[msg.sender]++;

        emit PlayerJoined(id, msg.sender, g.prizePool, g.players.length);
    }

    function submitScore(uint256 id, uint256 score, bytes memory signature) external gameExists(id) {
        Game storage g = games[id];
        require(g.status == GameStatus.Open, "Game not active");
        require(hasJoined[id][msg.sender], "Not a player");
        require(!hasSubmitted[id][msg.sender], "Already submitted");
        require(block.timestamp >= g.registrationEnd, "Registration still open");
        require(block.timestamp <= g.playDeadline, "Deadline passed");

        uint256 nonce = nonces[msg.sender];
        bytes32 message = keccak256(abi.encodePacked(msg.sender, id, score, nonce));
        require(recoverSigner(message, signature) == verifier, "Invalid signature");

        nonces[msg.sender]++;
        hasSubmitted[id][msg.sender] = true;
        hasFinished[id][msg.sender] = true;
        scores[id][msg.sender] = score;
        g.finishedCount++;

        emit ScoreSubmitted(id, msg.sender, score);
        if (g.finishedCount >= g.players.length) _endGame(id);
    }

    function triggerEnd(uint256 id) external gameExists(id) {
        Game storage g = games[id];
        require(g.status == GameStatus.Open, "Already ended");
        require(block.timestamp > g.playDeadline || g.finishedCount >= g.players.length, "Not ready");
        _endGame(id);
    }

    function claimPrize(uint256 id) external gameExists(id) {
        Game storage g = games[id];
        require(g.status == GameStatus.Ended, "Not ended");
        require(!hasClaimed[id][msg.sender], "Already claimed");

        uint8 pos = 0;
        uint256 n = g.players.length;
        if (g.topPlayers[0] == msg.sender) pos = 1;
        else if (n >= 2 && g.topPlayers[1] == msg.sender) pos = 2;
        else if (n >= 3 && g.topPlayers[2] == msg.sender) pos = 3;
        require(pos > 0, "Not a winner");

        uint256 prize = _calcPrize(g.prizePool, n, pos);
        require(prize > 0, "No prize");

        hasClaimed[id][msg.sender] = true;
        gamesWon[msg.sender]++;
        totalEarned[msg.sender] += prize;
        totalPaidOut += prize;

        (bool sent,) = payable(msg.sender).call{value: prize}("");
        require(sent, "Transfer failed");
        emit PrizeClaimed(id, msg.sender, prize, pos);
    }

    function cancelGame(uint256 id, string calldata reason) external gameExists(id) {
        Game storage g = games[id];
        require(msg.sender == g.creator || msg.sender == platform, "Not authorized");
        require(g.status == GameStatus.Open, "Cannot cancel");
        g.status = GameStatus.Cancelled;
        emit GameCancelled(id, reason);
    }

    function claimRefund(uint256 id) external gameExists(id) {
        Game storage g = games[id];
        require(g.status == GameStatus.Cancelled, "Not cancelled");
        require(hasJoined[id][msg.sender], "Not a player");
        hasJoined[id][msg.sender] = false;
        g.prizePool -= g.entryFee;
        (bool sent,) = payable(msg.sender).call{value: g.entryFee}("");
        require(sent, "Refund failed");
        emit RefundIssued(id, msg.sender, g.entryFee);
    }

    function _endGame(uint256 id) internal {
        Game storage g = games[id];
        g.status = GameStatus.Ended;
        uint256 n = g.players.length;
        if (n == 0) { g.status = GameStatus.Cancelled; emit GameCancelled(id, "No players"); return; }

        address[3] storage top = g.topPlayers;
        for (uint256 i = 0; i < n; i++) {
            address player = g.players[i];
            uint256 score = scores[id][player];
            if (top[0] == address(0) || score > scores[id][top[0]]) { top[2] = top[1]; top[1] = top[0]; top[0] = player; }
            else if (top[1] == address(0) || score > scores[id][top[1]]) { top[2] = top[1]; top[1] = player; }
            else if (top[2] == address(0) || score > scores[id][top[2]]) { top[2] = player; }
        }

        uint256 platformFee = (g.prizePool * PLATFORM_BPS) / 10000;
        uint256 creatorFee = (g.prizePool * CREATOR_BPS) / 10000;

        if (platformFee > 0) { (bool s,) = payable(platform).call{value: platformFee}(""); require(s, "Platform fee failed"); }
        if (creatorFee > 0 && !hasJoined[id][g.creator]) { (bool s,) = payable(g.creator).call{value: creatorFee}(""); require(s, "Creator fee failed"); }

        emit GameEnded(id, top[0], top[1], top[2]);
    }

    function _calcPrize(uint256 pool, uint256 n, uint8 pos) internal pure returns (uint256) {
        uint256 dist = (pool * 9500) / 10000;
        if (n == 1) return pos == 1 ? dist : 0;
        else if (n == 2) { if (pos == 1) return (dist * 7000) / 10000; if (pos == 2) return (dist * 3000) / 10000; }
        else { if (pos == 1) return (dist * 6000) / 10000; if (pos == 2) return (dist * 2500) / 10000; if (pos == 3) return (dist * 1500) / 10000; }
        return 0;
    }

    struct GameView {
        uint256 id; string name; address creator; uint8 categoryId; string categoryName;
        uint8 difficulty; uint256 entryFee; uint256 maxPlayers; uint256 prizePool;
        uint256 playerCount; uint256 registrationEnd; uint256 playDeadline;
        address[3] topPlayers; bool prizeClaimed; uint8 status; uint256 finishedCount;
    }

    function getGame(uint256 id) external view gameExists(id) returns (GameView memory) {
        Game storage g = games[id];
        return GameView({ id: g.id, name: g.name, creator: g.creator, categoryId: g.categoryId,
            categoryName: g.categoryName, difficulty: uint8(g.difficulty), entryFee: g.entryFee,
            maxPlayers: g.maxPlayers, prizePool: g.prizePool, playerCount: g.players.length,
            registrationEnd: g.registrationEnd, playDeadline: g.playDeadline,
            topPlayers: g.topPlayers, prizeClaimed: g.prizeClaimed, status: uint8(g.status),
            finishedCount: g.finishedCount });
    }

    function getPlayers(uint256 id) external view gameExists(id) returns (address[] memory) { return games[id].players; }

    function getPlayerStatus(uint256 id, address player) external view returns (bool, bool, bool, uint256) {
        return (hasJoined[id][player], hasFinished[id][player], hasClaimed[id][player], scores[id][player]);
    }

    function getPlayerStats(address player) external view returns (uint256, uint256, uint256) {
        return (gamesPlayed[player], gamesWon[player], totalEarned[player]);
    }

    function getLeaderboard(uint256 id) external view gameExists(id) returns (address[] memory, uint256[] memory, bool[] memory, bool[] memory) {
        Game storage g = games[id];
        uint256 n = g.players.length;
        address[] memory addrs = new address[](n);
        uint256[] memory scoreList = new uint256[](n);
        bool[] memory finished = new bool[](n);
        bool[] memory claimed_ = new bool[](n);
        for (uint256 i = 0; i < n; i++) {
            address p = g.players[i];
            addrs[i] = p; scoreList[i] = scores[id][p];
            finished[i] = hasFinished[id][p]; claimed_[i] = hasClaimed[id][p];
        }
        return (addrs, scoreList, finished, claimed_);
    }

    function getPrizeBreakdown(uint256 id) external view gameExists(id) returns (uint256, uint256, uint256, uint256) {
        Game storage g = games[id];
        uint256 n = g.players.length;
        return (_calcPrize(g.prizePool, n, 1), _calcPrize(g.prizePool, n, 2), _calcPrize(g.prizePool, n, 3), (g.prizePool * PLATFORM_BPS) / 10000);
    }

    function recoverSigner(bytes32 message, bytes memory sig) internal pure returns (address) {
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", message));
        (bytes32 r, bytes32 s, uint8 v) = splitSignature(sig);
        return ecrecover(ethSigned, v, r, s);
    }

    function splitSignature(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "Invalid signature");
        assembly { r := mload(add(sig, 32)) s := mload(add(sig, 64)) v := byte(0, mload(add(sig, 96))) }
    }

    receive() external payable {}
}
