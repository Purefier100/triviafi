// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TriviaFiTournament {
    address public owner;
    address public verifier;

    struct TournamentScore {
        address player;
        uint256 tournamentId;
        uint256 roundNumber;
        uint256 score;
        uint256 timestamp;
        bool submitted;
    }

    // tournamentId => roundNumber => wallet => score
    mapping(uint256 => mapping(uint256 => mapping(address => TournamentScore))) public scores;
    
    // tournamentId => roundNumber => list of players who submitted
    mapping(uint256 => mapping(uint256 => address[])) public roundPlayers;
    
    // tournamentId => roundNumber => wallet => already submitted
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public hasSubmitted;

    event ScoreSubmitted(
        uint256 indexed tournamentId,
        uint256 indexed roundNumber,
        address indexed player,
        uint256 score,
        uint256 timestamp
    );

    event VerifierUpdated(address oldVerifier, address newVerifier);

    constructor(address _verifier) {
        owner = msg.sender;
        verifier = _verifier;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    function setVerifier(address _verifier) external onlyOwner {
        emit VerifierUpdated(verifier, _verifier);
        verifier = _verifier;
    }

    function submitScore(
        uint256 tournamentId,
        uint256 roundNumber,
        uint256 score,
        uint256 nonce,
        bytes calldata signature
    ) external {
        require(!hasSubmitted[tournamentId][roundNumber][msg.sender], "Already submitted");
        require(score <= 1000, "Score too high"); // max 10 questions * 100pts

        // Verify signature from backend verifier
        bytes32 message = keccak256(abi.encodePacked(
            msg.sender,
            tournamentId,
            roundNumber,
            score,
            nonce
        ));
        bytes32 ethSignedMessage = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n32",
            message
        ));
        
        address recovered = recoverSigner(ethSignedMessage, signature);
        require(recovered == verifier, "Invalid signature");

        // Record score
        scores[tournamentId][roundNumber][msg.sender] = TournamentScore({
            player: msg.sender,
            tournamentId: tournamentId,
            roundNumber: roundNumber,
            score: score,
            timestamp: block.timestamp,
            submitted: true
        });

        hasSubmitted[tournamentId][roundNumber][msg.sender] = true;
        roundPlayers[tournamentId][roundNumber].push(msg.sender);

        emit ScoreSubmitted(tournamentId, roundNumber, msg.sender, score, block.timestamp);
    }

    function getScore(
        uint256 tournamentId,
        uint256 roundNumber,
        address player
    ) external view returns (uint256 score, uint256 timestamp, bool submitted) {
        TournamentScore memory s = scores[tournamentId][roundNumber][player];
        return (s.score, s.timestamp, s.submitted);
    }

    function getRoundPlayers(
        uint256 tournamentId,
        uint256 roundNumber
    ) external view returns (address[] memory) {
        return roundPlayers[tournamentId][roundNumber];
    }

    function getRoundSubmissionCount(
        uint256 tournamentId,
        uint256 roundNumber
    ) external view returns (uint256) {
        return roundPlayers[tournamentId][roundNumber].length;
    }

    function recoverSigner(
        bytes32 ethSignedMessageHash,
        bytes memory signature
    ) internal pure returns (address) {
        require(signature.length == 65, "Invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "Invalid v value");
        return ecrecover(ethSignedMessageHash, v, r, s);
    }

    // Emergency: owner can clear a bad score (e.g. if backend was compromised)
    function clearScore(
        uint256 tournamentId,
        uint256 roundNumber,
        address player
    ) external onlyOwner {
        hasSubmitted[tournamentId][roundNumber][player] = false;
        delete scores[tournamentId][roundNumber][player];
    }
}