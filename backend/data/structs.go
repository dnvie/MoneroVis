package data

type GetBlockResponse struct {
	Result BlockResult `json:"result"`
}

type BlockResult struct {
	BlockHeader BlockHeader `json:"block_header"`
	Json        string      `json:"json"`
	Status      string      `json:"status"`
	TxHashes    []string    `json:"tx_hashes"`
}

type BlockHeader struct {
	Hash        string `json:"hash"`
	Height      uint64 `json:"height"`
	BlockSize   uint64 `json:"block_size"`
	MinerTxHash string `json:"miner_tx_hash"`
	Nonce       uint64 `json:"nonce"`
	Timestamp   uint64 `json:"timestamp"`
	NumTxes     int    `json:"num_txes"`
	Reward      uint64 `json:"reward"`
	Difficulty  uint64 `json:"difficulty"`
	Depth       uint64 `json:"depth"`
}

type GetInfoResponse struct {
	Result InfoResult `json:"result"`
}

type InfoResult struct {
	Height           uint64 `json:"height"`
	BlockWeightLimit uint64 `json:"block_weight_limit"`
	Status           string `json:"status"`
}

type GetBlockHeadersRangeResponse struct {
	Result BlockHeadersRangeResult `json:"result"`
}

type BlockHeadersRangeResult struct {
	Headers []BlockHeader `json:"headers"`
	Status  string        `json:"status"`
}

type BlocksResponse struct {
	Blocks      []BlockListEntry `json:"blocks"`
	Page        int              `json:"page"`
	TotalPages  int              `json:"totalPages"`
	TotalBlocks uint64           `json:"totalBlocks"`
}

type BlockListEntry struct {
	Height       uint64  `json:"height"`
	Hash         string  `json:"hash"`
	Timestamp    string  `json:"timestamp"`
	TimestampRaw uint64  `json:"timestampRaw"`
	RelativeTime string  `json:"relativeTime"`
	Size         float64 `json:"size"`
	TxCount      int     `json:"txCount"`
	Reward       float64 `json:"reward"`
}

type Block struct {
	Height       uint64               `json:"height"`
	Hash         string               `json:"hash"`
	Timestamp    string               `json:"timestamp"`
	RelativeTime string               `json:"relativeTime"`
	BlockSize    float64              `json:"blockSize"`
	Depth        uint64               `json:"depth"`
	Nonce        uint64               `json:"nonce"`
	MinerTx      MinerTransaction     `json:"minerTx"`
	Transactions []MinimalTransaction `json:"transactions"`
	TotalFees    float64              `json:"totalFees"`
	MinFee       float64              `json:"minFee"`
	MaxFee       float64              `json:"maxFee"`
	Status       string               `json:"status"`
}

type MinerTransaction struct {
	Hash    string  `json:"hash"`
	Size    float64 `json:"size"`
	Outputs float64 `json:"outputs"`
}

type MinimalTransaction struct {
	Hash string  `json:"hash"`
	Size float64 `json:"size"`
	Fee  float64 `json:"fee"`
	In   int     `json:"in"`
	Out  int     `json:"out"`
}

type RawBlock struct {
	MinerTx RawMinerTx `json:"miner_tx"`
}

type RawMinerTx struct {
	Vout []RawVout `json:"vout"`
}

type RawVout struct {
	Amount uint64 `json:"amount"`
}

type GetMinimalTxResponse struct {
}

type RawMinimalTransaction struct {
	Vin           []MinimalTxInput     `json:"vin"`
	Vout          []MinimalTxOutput    `json:"vout"`
	RCTSignatures MinimalRCTSignatures `json:"rct_signatures"`
	Hash          string               `json:"hash"`
	Size          float64              `json:"size"`
	Fee           uint64               `json:"fee"`
	NumInputs     int                  `json:"num_inputs"`
	NumOutputs    int                  `json:"num_outputs"`
}

type MinimalTxInput struct {
	Key MinimalTxInputKey `json:"key"`
}

type MinimalTxInputKey struct {
	Amount     uint64   `json:"amount"`
	KeyOffsets []uint64 `json:"key_offsets"`
}

type MinimalTxOutput struct {
	Amount uint64 `json:"amount"`
}

type MinimalRCTSignatures struct {
	TxnFee uint64 `json:"txnFee"`
}

type NodeResponse struct {
	Credits   int      `json:"credits"`
	Status    string   `json:"status"`
	TopHash   string   `json:"top_hash"`
	Txs       []Tx     `json:"txs"`
	TxsAsHex  []string `json:"txs_as_hex"`
	TxsAsJSON []string `json:"txs_as_json"`
	Untrusted bool     `json:"untrusted"`
}

type Tx struct {
	AsHex           string `json:"as_hex"`
	AsJSON          string `json:"as_json"`
	BlockHeight     int    `json:"block_height"`
	BlockTimestamp  int    `json:"block_timestamp"`
	Confirmations   int    `json:"confirmations"`
	DoubleSpendSeen bool   `json:"double_spend_seen"`
	InPool          bool   `json:"in_pool"`
	OutputIndices   []int  `json:"output_indices"`
	PrunableAsHex   string `json:"prunable_as_hex"`
	PrunableHash    string `json:"prunable_hash"`
	PrunedAsHex     string `json:"pruned_as_hex"`
	TxHash          string `json:"tx_hash"`
}

type TaggedKeyOutput struct {
	Key     string `json:"key"`
	ViewTag string `json:"view_tag"`
}

type TransactionDetail struct {
	Version    int `json:"version"`
	UnlockTime int `json:"unlock_time"`
	Vin        []struct {
		Key struct {
			Amount     int    `json:"amount"`
			KeyOffsets []int  `json:"key_offsets"`
			KImage     string `json:"k_image"`
		} `json:"key"`
	} `json:"vin"`
	Vout []struct {
		Amount int `json:"amount"`
		Target struct {
			Key       string          `json:"key"`
			TaggedKey TaggedKeyOutput `json:"tagged_key"`
		} `json:"target"`
	} `json:"vout"`
	Extra         []int `json:"extra"`
	RctSignatures struct {
		Type     int `json:"type"`
		TxnFee   int `json:"txnFee"`
		EcdhInfo []struct {
			Amount string `json:"amount"`
		} `json:"ecdhInfo"`
		OutPk []string `json:"outPk"`
	} `json:"rct_signatures"`
	RctsigPrunable struct {
		Nbp int `json:"nbp"`
		Bp  []struct {
			A    string   `json:"A"`
			S    string   `json:"S"`
			T1   string   `json:"T1"`
			T2   string   `json:"T2"`
			Taux string   `json:"taux"`
			Mu   string   `json:"mu"`
			L    []string `json:"L"`
			R    []string `json:"R"`
			A2   string   `json:"a"`
			B    string   `json:"b"`
			T    string   `json:"t"`
		} `json:"bp"`
		MGs []struct {
			Ss [][]string `json:"ss"`
			Cc string     `json:"cc"`
		} `json:"MGs"`
		PseudoOuts []string `json:"pseudoOuts"`
	} `json:"rctsig_prunable"`
}

type Transaction struct {
	BlockHeight    int        `json:"block_height"`
	BlockTimestamp int        `json:"block_timestamp"`
	RelativeTime   string     `json:"relative_time"`
	Confirmations  int        `json:"confirmations"`
	Version        int        `json:"version"`
	Inputs         []TxInput  `json:"inputs"`
	Outputs        []TxOutput `json:"outputs"`
	TxHash         string     `json:"tx_hash"`
	Extra          string     `json:"extra"`
	Type           int        `json:"type"`
	TxnFee         int        `json:"txnFee"`
	Size           float64    `json:"size"`
}

type TxInput struct {
	KeyImage    string       `json:"key_image"`
	Amount      uint64       `json:"amount,omitempty"`
	RingMembers []RingMember `json:"ring_members"`
}

type RingMember struct {
	Hash              string `json:"hash"`
	BlockHeight       int    `json:"block_height"`
	ParentTransaction string `json:"parent_transaction"`
	DecoyCount        int    `json:"decoy_count"`
	IsCoinbase        bool   `json:"is_coinbase"`
}

type TxOutput struct {
	StealthAddress string `json:"stealth_address"`
	ViewTag        string `json:"view_tag,omitempty"`
	Amount         uint64 `json:"amount,omitempty"`
	OutputIndex    int    `json:"output_index"`
}

type GetOutsResponse struct {
	Outs   []Out  `json:"outs"`
	Status string `json:"status"`
}

type Out struct {
	Key    string `json:"key"`
	Height uint64 `json:"height"`
	TxID   string `json:"txid"`
}

type OutRequest struct {
	Amount uint64 `json:"amount"`
	Index  uint64 `json:"index"`
}

type HomeData struct {
	Blocks           []HomeBlock     `json:"blocks"`
	Mempool          []HomeMempoolTx `json:"mempool"`
	BlockWeightLimit uint64          `json:"blockWeightLimit"`
}

type HomeBlock struct {
	Height       uint64  `json:"height"`
	TxCount      int     `json:"txCount"`
	Hash         string  `json:"hash"`
	Reward       float64 `json:"reward"`
	RelativeTime string  `json:"relativeTime"`
	Timestamp    uint64  `json:"timestamp"`
}

type HomeMempoolTx struct {
	Hash    string  `json:"hash"`
	Size    float64 `json:"size"`
	Fee     float64 `json:"fee"`
	Inputs  int     `json:"inputs"`
	Outputs int     `json:"outputs"`
}

type GetTransactionPoolResponse struct {
	Status       string               `json:"status"`
	Transactions []MempoolTransaction `json:"transactions"`
}

type MempoolTransaction struct {
	IdHash   string `json:"id_hash"`
	BlobSize uint64 `json:"blob_size"`
	Fee      uint64 `json:"fee"`
	TxJSON   string `json:"tx_json"`
}
