const db = {
	name: 'ExpenseDB',
	version: 1,
	store: 'records',
	
	open() {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.name, this.version);
			request.onupgradeneeded = e => {
				const db = e.target.result;
				if (!db.objectStoreNames.contains(this.store)) {
					db.createObjectStore(this.store, { keyPath: 'time' });
				}
			};
			request.onsuccess = e => resolve(e.target.result);
			request.onerror = e => reject(e);
		});
	},

	async getAll() {
		const database = await this.open();
		return new Promise((resolve, reject) => {
			const transaction = database.transaction(this.store, 'readonly');
			const request = transaction.objectStore(this.store).getAll();
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	},

	async saveAll(records) {
		const database = await this.open();
		return new Promise((resolve, reject) => {
			const transaction = database.transaction(this.store, 'readwrite');
			const store = transaction.objectStore(this.store);
			store.clear();
			const rawRecords = JSON.parse(JSON.stringify(records));
			rawRecords.forEach(r => store.put(r));
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
	},

	async clear() {
		const database = await this.open();
		const transaction = database.transaction(this.store, 'readwrite');
		transaction.objectStore(this.store).clear();
	}
};
